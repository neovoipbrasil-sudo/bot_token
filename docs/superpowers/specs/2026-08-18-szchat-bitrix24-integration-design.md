# Integração SZ.chat ↔ Bitrix24 — Design

Data: 2026-08-18

## Problema

A empresa atende clientes pelo SZ.chat (plataforma omnichannel da Fortics —
WhatsApp, webchat, redes sociais etc.), mas essa interação não deixa rastro no
Bitrix24, e não há forma automatizada de enviar mensagens ao cliente pelo
SZ.chat a partir de uma automação do Bitrix24.

## Objetivo

Integração de mão dupla:

- **Entrada** (SZ.chat → Bitrix24): a cada mensagem trocada numa conversa do
  SZ.chat, registrar automaticamente um comentário na timeline do Deal (ou
  Lead, se não houver Deal aberto) correspondente, identificado pelo telefone
  do contato. Mesmo objetivo que a integração já existente com o MSN Talk
  (`src/msntalk/`), agora para o SZ.chat.
- **Saída** (Bitrix24 → SZ.chat): um Business Process / automação do Bitrix24
  aciona um endpoint HTTP nosso para enviar uma mensagem a um contato através
  da API REST do SZ.chat.

**Fora de escopo:** UI de atendimento dentro do Bitrix24; o bot assistente
(imbot v2) não participa disso; não criamos/gerenciamos atendimentos
(attendances) no SZ.chat, só lemos eventos de webhook e enviamos mensagens
avulsas. Não usamos n8n — tudo roda como código neste repositório, seguindo o
padrão já estabelecido pelo `msntalk`.

## Descoberta técnica pendente

Ao contrário do MSN Talk (onde o payload real do webhook já tinha sido
capturado em produção antes do design), para o SZ.chat ainda faltam dois
insumos que bloqueiam a implementação final:

1. **Payload real do webhook de saída do SZ.chat.** A documentação pública
   (`https://docs.fortics.com.br/gestao-and-operacao/tutoriais/chat-center/configuracao-de-webhook-api-de-saida.md`)
   lista os gatilhos disponíveis (entre eles "mensagem do cliente" e
   "atendimento finalizado"), mas não documenta a estrutura JSON de cada
   evento. É preciso configurar o webhook em **Integrações > API** no painel
   do SZ.chat apontando para um destino temporário (webhook.site, ou log
   temporário no nosso servidor — mesmo procedimento usado no plano de
   anexos do bot), disparar mensagens de teste reais e capturar o JSON antes
   de escrever `webhook-handler.js` de verdade.
2. **Credenciais da Chat Center API.** A doc pública indica login via e-mail
   + senha (`POST /api/v4/auth/login`) retornando um JWT Bearer, usado na
   maioria dos endpoints — inclusive `/api/v4/message/send`, usado para o
   envio. Precisamos de um usuário de serviço (e-mail/senha) com permissão de
   envio de mensagens, mais o `platform_id` e `channel_id` do canal (ex.:
   WhatsApp) que vamos usar para enviar. O link do painel que você tem
   (`https://emi.sz.chat/`) é o subdomínio da conta — não confirma ainda essas
   credenciais.

Essas duas descobertas viram tasks explícitas no plano de implementação, antes
de qualquer código de parsing/client ser escrito "para valer" — o resto deste
documento descreve a arquitetura assumindo o formato mais provável (baseado na
doc pública), que deve ser corrigido pela descoberta real quando disponível.

## Arquitetura

Reaproveita o mesmo servidor Express do bot Bitrix24 (`src/bot/server.js`),
mesmo processo, mesmo deploy (Easypanel) — sem novo serviço.

```
SZ.chat (webhook de saída) ─POST─▶ /szchat-events/:secret
                                        │
                                        ▼
                            szchat/webhook-handler.js  (normaliza o payload)
                                        │
                                        ▼
                            msntalk/find-crm-entity.js  (reaproveitado — telefone → deal/lead)
                                        │
                                        ▼
                            szchat/sync-timeline.js  (monta e grava o comentário via timelineAdd)
                                        │
                                  (sem match) → audit-log


Business Process Bitrix24 ─POST─▶ /szchat-send/:secret
                                        │
                                        ▼
                            szchat/client.js  (login JWT + POST /api/v4/message/send)
```

## Componentes

### `src/szchat/webhook-handler.js`

```js
function parseSzChatEvent(body) → {
  phone, text, direction: 'inbound' | 'outbound',
  ticketId, contactName, timestamp,
} | null
```

Mesmo contrato de `parseMsnTalkEvent` (`src/msntalk/webhook-handler.js`).
Eventos irrelevantes (gatilho que não é mensagem, ou sem telefone
reconhecível) retornam `null` em vez de lançar erro — o parser nunca deve
derrubar o processamento do webhook por um formato inesperado. A implementação
real dos campos usados (nomes exatos de `evento`/`msg`/`contact` etc.) é
escrita a partir dos payloads capturados na etapa de descoberta.

### `src/szchat/sync-timeline.js`

Espelha `src/msntalk/sync-timeline.js`: orquestra
`find-crm-entity.js` (reaproveitado sem alteração, já é agnóstico à origem —
só recebe telefone) e chama `timelineAdd({ entity, entity_id, comment })`.
Texto do comentário:

```
[SZ.chat] Cliente: <texto>
```
ou
```
[SZ.chat] Atendente: <texto>
```

Grava a data da última mensagem num campo custom próprio (`UF_CRM_LASTSZCHAT`,
por analogia a `UF_CRM_LASTMSNTALK`) para não colidir com o do MSN Talk. Se
`SZCHAT_TICKET_URL_TEMPLATE` estiver definida, acrescenta um link pro
atendimento. Sem match de CRM → grava em audit log
(`auditLog.logAction({ tool: 'szchat-sync', params: { phone, ticketId }, result: 'no-match' })`)
e encerra sem erro, sem tentar de novo.

### `src/szchat/client.js` (novo)

Cliente HTTP do SZ.chat:

- `login()` — `POST {SZCHAT_BASE_URL}/api/v4/auth/login` com
  `{ email: SZCHAT_EMAIL, password: SZCHAT_PASSWORD }`, guarda o JWT retornado
  em memória (variável de módulo, sem persistência em disco).
- `sendMessage({ phone, text })` — `POST {SZCHAT_BASE_URL}/api/v4/message/send`
  com `Authorization: Bearer <token>`, `platform_id: SZCHAT_PLATFORM_ID`,
  `channel_id: SZCHAT_CHANNEL_ID`, `type: 'text'`, `message: text`, e
  identificação do contato pelo telefone (campo exato a confirmar na
  descoberta — candidato mais provável hoje é `contact_data`/
  `contact_variables`, já que o schema público não documenta um campo `phone`
  direto em `message/send`).
- Em resposta `401` (token expirado), refaz `login()` uma vez e repete a
  chamada antes de propagar o erro.

### Rotas novas em `src/bot/server.js`

Seguem o padrão já usado por `/msntalk-events/:secret`: `createApp` passa a
aceitar também `{ szchatWebhookSecret, szchatSendSecret, szchatClient }`.

- **`POST /szchat-events/:secret`** — compara `:secret` com
  `szchatWebhookSecret`; se não bater, `404` genérico (não `403`, para não
  confirmar a existência da rota). Se bater, responde `200` imediatamente
  (ack rápido) e processa o evento de forma assíncrona — erros no
  processamento só são logados, nunca derrubam o processo nem retornam erro
  pro SZ.chat (sem retry possível do lado deles).
- **`POST /szchat-send/:secret`** — compara `:secret` com `szchatSendSecret`;
  `404` se não bater. Espera `{ phone, message }` no body (é isso que o
  Business Process do Bitrix24 vai enviar). Ao contrário da rota de entrada,
  **aqui a resposta espera o resultado do envio** (não é fire-and-forget),
  porque o Business Process precisa saber se deu certo: `200` com o retorno do
  SZ.chat em caso de sucesso, `502` com a mensagem de erro se o envio falhar —
  para o BP poder tratar/alertar.

### `src/bot/bootstrap.js`

Monta `szchatClient` (`src/szchat/client.js`) e lê do ambiente:
`SZCHAT_WEBHOOK_SECRET`, `SZCHAT_SEND_SECRET`, `SZCHAT_BASE_URL`,
`SZCHAT_EMAIL`, `SZCHAT_PASSWORD`, `SZCHAT_PLATFORM_ID`, `SZCHAT_CHANNEL_ID` —
falha ao subir se alguma faltar (mesmo padrão de `MSNTALK_WEBHOOK_SECRET`
hoje).

## Configuração

Novas variáveis de ambiente (documentar no `.env.example`):

- `SZCHAT_WEBHOOK_SECRET` — segredo no path da rota de entrada; configurado
  como URL de webhook no painel do SZ.chat (Integrações > API):
  `https://<host>/szchat-events/<SZCHAT_WEBHOOK_SECRET>`.
- `SZCHAT_SEND_SECRET` — segredo no path da rota de saída, usado pelo
  Business Process do Bitrix24 para chamar
  `https://<host>/szchat-send/<SZCHAT_SEND_SECRET>`.
- `SZCHAT_BASE_URL` — URL base da API (ex.: `https://emi.sz.chat`).
- `SZCHAT_EMAIL` / `SZCHAT_PASSWORD` — credenciais do usuário de serviço para
  login JWT.
- `SZCHAT_PLATFORM_ID` / `SZCHAT_CHANNEL_ID` — canal usado para envio de
  mensagens (ex.: WhatsApp).
- `SZCHAT_TICKET_URL_TEMPLATE` (opcional) — deep link pro atendimento, se
  existir equivalente no SZ.chat.

## Testes

- `webhook-handler.test.js` — fixtures com os payloads reais capturados na
  descoberta, mais um evento de gatilho irrelevante (`null`) e payload sem
  telefone (`null`).
- `sync-timeline.test.js` — mocka `find-crm-entity` e `timelineAdd`; cobre
  caminho feliz (inbound e outbound) e "sem match" (grava audit log, não
  chama `timelineAdd`).
- `client.test.js` — mocka as chamadas HTTP de login e `message/send`; cobre
  login inicial, reautenticação em `401`, e propagação de erro em falha
  persistente.
- Teste de integração das rotas (mesmo estilo de `server.test.js`): secret
  errado → 404 em ambas; `/szchat-events` com evento válido → chama a cadeia
  de sync e responde 200 antes de terminar o processamento; `/szchat-send` com
  sucesso → 200; com falha do client → 502.

## Riscos / limitações conhecidas

- Sem assinatura no webhook do SZ.chat (a documentação pública não menciona
  mecanismo de assinatura/secret no corpo), a segurança depende inteiramente
  do segredo na URL não vazar — mesmo modelo de risco aceito para o MSN Talk.
- Contato com telefone divergente do cadastrado no Bitrix24 não gera match e
  cai silenciosamente no audit log, sem alerta ativo nesta primeira versão.
- Mensagens proativas (iniciadas pelo Bitrix24 fora de uma janela de
  atendimento aberta) podem exigir um template HSM aprovado pelo WhatsApp em
  vez de texto livre — a doc pública não confirma se isso é obrigatório; a
  etapa de descoberta deve validar enviando uma mensagem de teste fora de
  atendimento ativo, e se necessário `client.js#sendMessage` ganha um segundo
  modo (`hsm_template_name` + `hsm_placeholders`) antes de ir para produção.
