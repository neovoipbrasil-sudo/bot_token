# Integração MSN Talk ↔ Bitrix24 — Design

Data: 2026-07-20

## Problema

O SDR conversa com o lead pelo MSN Talk (plataforma de atendimento/chat multicanal
usada pela empresa), mas essa interação não deixa nenhum rastro no Bitrix24: o
Lead/Deal correspondente fica com aparência de "sem movimentação", mesmo havendo
troca de mensagens ativa. Não há hoje nenhuma automação ligando os dois sistemas.

## Objetivo

A cada mensagem trocada numa conversa do MSN Talk (do cliente ou do SDR), registrar
automaticamente um comentário na timeline do Deal (ou Lead, se não houver Deal aberto)
correspondente no Bitrix24, identificado pelo número de telefone do contato.

Fora de escopo: qualquer alteração no lado do MSN Talk (tags, campos extras); esse
projeto só consome o webhook de eventos do MSN Talk e escreve no Bitrix24.

## Descoberta técnica (validada com eventos reais capturados via webhook.site)

O MSN Talk (produto "Z-PRO") dispara `POST` para uma URL configurável no painel
sempre que há atividade numa conversa. Dois formatos de evento relevantes foram
observados:

```jsonc
// Mensagem do cliente (ou do SDR, indicado por msg.fromMe)
{
  "method": "message",
  "msg": {
    "fromMe": false,
    "text": "Bom dia Gabriel...",
    "body": "Bom dia Gabriel...",
    "from": "556121090177",
    "timestamp": 1784556288057,
    "messageType": "Conversation" // ou "ContactMessage", etc.
  },
  "ticket": {
    "id": 92315,
    "protocol": "2026200710580392315",
    "status": "open",
    "userId": 183,           // atendente responsável (pode ser null)
    "contactId": 90604,
    "contact": { "id": 90604, "number": "556121090177", "name": "..." }
  }
}

// Resposta enviada pelo SDR através da plataforma
{
  "method": "message_send_uazapi",
  "msg": { "message": "*Gabriel Rodrigues*:\n Queria confirmar..." },
  "ticket": {
    "id": 92315,
    "contactId": 90604,
    "contact": { "id": 90604, "number": "556121090177", "name": "..." }
  }
}
```

Achados importantes:

- `ticket.contact.number` está presente em **todos** os eventos capturados — é a
  chave de match confiável (telefone puro, sem `+`, ex. `556121090177`).
- Não há assinatura nem token no corpo ou nos headers da requisição. A segurança do
  webhook do MSN Talk é "quem sabe a URL, chama" — mesmo modelo que um Bitrix24
  incoming webhook. Portanto o segredo tem que estar embutido no path da nossa rota.
- Outros valores de `method` podem existir e não foram observados; o parser deve
  ignorá-los (no-op) em vez de falhar.
- O painel MSN Talk tem deep link confirmado para abrir um ticket específico:
  `https://app.msntalk.neovoip.com.br/atendimento?ticketId={ticketId}`.

## Arquitetura

Reaproveita o servidor Express que já atende o bot Bitrix24
(`src/bot/server.js`, rota `/bitrix-events`) — mesmo processo, mesma porta pública,
sem novo serviço.

```
MSN Talk ─POST─▶ /msntalk-events/:secret
                     │
                     ▼
            webhook-handler.js  (normaliza o payload)
                     │
                     ▼
            find-crm-entity.js  (telefone → Deal aberto > Lead aberto)
                     │
                     ▼
            sync-timeline.js  (monta e grava o comentário via timelineAdd)
                     │
              (sem match) → audit-log
```

## Componentes

### `src/msntalk/webhook-handler.js`

Recebe o body bruto do POST e retorna um evento normalizado ou `null` (evento
irrelevante/desconhecido):

```js
{
  phone: '556121090177',
  text: 'Bom dia Gabriel...',
  direction: 'inbound' | 'outbound',
  ticketId: 92315,
  protocol: '2026200710580392315',
}
```

Regras:
- `method: "message"` → `direction` é `'outbound'` se `msg.fromMe === true`,
  senão `'inbound'`. Texto vem de `msg.text` (fallback `msg.body`).
- `method: "message_send_uazapi"` → sempre `'outbound'` (é o SDR respondendo).
  Texto vem de `msg.message`.
- Qualquer outro `method`, ou payload sem `ticket.contact.number`, retorna `null`.

### `src/msntalk/find-crm-entity.js`

```js
async function findCrmEntity(client, phone) → { entity: 'deal' | 'lead', entity_id } | null
```

Retorna diretamente no formato que `timelineAdd` (`src/tools/crm.js:145-159`)
espera — `entity` como string (`'deal'` ou `'lead'`) e `entity_id` — para
`sync-timeline.js` poder chamar `timelineAdd` sem nenhuma camada de conversão.

1. `crm.duplicate.findbycomm` (tipo `PHONE`, valor `phone`) → IDs de Contact,
   Company e Lead que batem com o telefone (o Bitrix24 retorna os três tipos por
   padrão quando `entity_type` não é informado).
2. Se houver Contact e/ou Company: `crm.deal.list` filtrando
   `(CONTACT_ID nesses IDs) OR (COMPANY_ID nesses IDs)` e `CLOSED = N`, ordenado
   por `DATE_CREATE` desc — pega o primeiro (Deal aberto mais recente). Cobre o
   caso de telefone cadastrado só na Empresa, sem Contato associado ao Deal.
3. Se não achou Deal: entre os Leads retornados por `findbycomm`, filtra os que
   têm `STATUS_SEMANTIC_ID = P` (em aberto) e pega o mais recente.
4. Se nada encontrado, retorna `null`.

Normalização de telefone: `crm.duplicate.findbycomm` já faz matching tolerante a
formatação no lado do Bitrix24, então o número é passado como veio do MSN Talk
(dígitos puros, com DDI), sem normalização extra no nosso lado.

### `src/msntalk/sync-timeline.js`

Orquestra os dois módulos acima e chama `timelineAdd({ entity, entity_id, comment })`
(já existe em `src/tools/crm.js`, cria seu próprio `Bitrix24Client` internamente)
com o resultado de `find-crm-entity.js`, repassado sem conversão. Texto do
comentário:

```
[MSN Talk] Cliente: Bom dia Gabriel...
```
ou
```
[MSN Talk] SDR: Queria confirmar...
```

Se `MSNTALK_TICKET_URL_TEMPLATE` estiver definida (default sugerido:
`https://app.msntalk.neovoip.com.br/atendimento?ticketId={ticketId}`), acrescenta
uma linha com o link resolvido. Se não achou entidade correspondente, chama
`auditLog.logAction({ tool: 'msntalk-sync', params: { phone, ticketId }, result: 'no-match' })`
usando a instância de `createAuditLog` já existente em `src/bot/audit-log.js`, e
encerra sem erro.

### Rota `POST /msntalk-events/:secret` em `src/bot/server.js`

`createApp` (`src/bot/server.js:3`) hoje recebe só `{ botConfig, agentLoop, reply,
rateLimiter }` — não tem `auditLog` nem um `Bitrix24Client`. Para a nova rota
reutilizar a instância de `auditLog` já criada em `bootstrap.js:24` (hoje só
passada para `agentLoop`), `createApp` precisa passar a aceitar também
`{ auditLog, bitrixClient, msntalkWebhookSecret }`, e `bootstrap.js` precisa
repassá-los na chamada de `createApp(...)`.

- Compara `:secret` com o parâmetro `msntalkWebhookSecret` recebido por
  `createApp` — mesmo padrão já usado pela rota `/bitrix-events`, que compara
  contra `botConfig.botToken` injetado, e não lê `process.env` diretamente
  dentro de `server.js`. `bootstrap.js` é quem lê
  `process.env.MSNTALK_WEBHOOK_SECRET` e falha ao subir se a env não estiver
  definida (mesmo padrão de outras envs críticas do bot).
- Se não bater, responde `404` genérico (não `403`, para não confirmar a
  existência da rota a quem estiver tentando adivinhar o path).
- Se bater, responde `200` imediatamente e processa o evento de forma assíncrona
  (mesmo padrão de "ack rápido, processa depois" já usado em `/bitrix-events`).
- Erros durante o processamento (ex.: chamada Bitrix24 falhou) são apenas
  logados — nunca derrubam o processo nem retornam erro pro MSN Talk (que não
  temos como tratar retry de qualquer forma).

## Configuração

Novas variáveis de ambiente (documentar no `.env.example`):

- `MSNTALK_WEBHOOK_SECRET` — segmento aleatório usado no path da rota; deve ser
  configurado como URL de webhook no painel do MSN Talk:
  `https://<host>/msntalk-events/<MSNTALK_WEBHOOK_SECRET>`.
- `MSNTALK_TICKET_URL_TEMPLATE` (opcional) — template de deep link para o ticket,
  com placeholder `{ticketId}`. Se ausente, o comentário não inclui link. Valor
  confirmado: `https://app.msntalk.neovoip.com.br/atendimento?ticketId={ticketId}`.

## Testes

- `webhook-handler.test.js` — cobre os dois formatos de evento reais capturados
  (fixtures baseados nos payloads coletados), mais um `method` desconhecido
  (deve retornar `null`) e payload sem `contact.number` (deve retornar `null`).
- `find-crm-entity.test.js` — mocka `Bitrix24Client.call` para os cenários: Deal
  aberto encontrado via Contact, Deal aberto encontrado só via Company (sem
  Contact), só Lead aberto encontrado, nenhum encontrado.
- `sync-timeline.test.js` — mocka os dois módulos acima e `timelineAdd`, cobre
  caminho feliz (inbound e outbound) e caminho "sem match" (grava no audit log,
  não chama `timelineAdd`).
- Teste de integração da rota (similar a `server.test.js` já existente): secret
  errado → 404; secret certo com evento válido → chama a cadeia de sync; secret
  certo com `method` desconhecido → 200 sem side effect.

## Riscos / limitações conhecidas

- Sem assinatura no webhook do MSN Talk, a segurança depende inteiramente do
  segredo na URL não vazar (não deve aparecer em logs de acesso com o path
  completo em nível `info`, por exemplo).
- Contatos com telefone divergente do cadastrado no Bitrix24 (ex.: número pessoal
  vs. corporativo) não terão match e caem silenciosamente no audit log; não há,
  nesta primeira versão, alerta ativo para esses casos.
