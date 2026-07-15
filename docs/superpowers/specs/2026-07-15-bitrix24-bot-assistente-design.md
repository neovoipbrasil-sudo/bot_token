# Assistente Claude via bot do Bitrix24 — Design

Data: 2026-07-15
Status: Aprovado para planejamento

## Contexto e objetivo

Hoje o `bitrix24-mcp` funciona sob demanda: alguém abre uma sessão do Claude Code e pede uma ação, que é executada via `Bitrix24Client`/`Bitrix24Reader`/`Bitrix24Writer`. Não existe caminho para um usuário do Bitrix24 disparar uma tarefa sozinho, sem alguém operando o Claude Code.

Objetivo: permitir que qualquer usuário do portal mande uma mensagem em um chat 1:1 com um bot do Bitrix24 ("Assistente"), descrevendo o que precisa (ex: "cria uma tarefa pro João revisar o contrato até sexta", "quantos leads entraram essa semana?"), e o pedido seja interpretado e executado automaticamente, sem intervenção humana — rodando 24/7 no servidor que o usuário já possui.

### Restrição técnica de plataforma

Bots do Bitrix24 só recebem eventos de chats onde participam. O chat "notas para mim mesmo" não inclui o bot, então não é possível ouvir esse canal específico. Solução adotada: cada usuário conversa com o bot num chat 1:1 dedicado (equivalente na prática a "falar sozinho", mas dentro de uma conversa com o assistente).

## Arquitetura

```
Usuário (chat 1:1 com o bot)
        │  mensagem de texto
        ▼
Bitrix24 Portal  ──POST evento ONIMBOTMESSAGEADD──▶  Bot Server (novo processo Node.js)
        ▲                                                   │
        │  imbot.message.add (resposta/confirmação)         │
        └───────────────────────────────────────────────────┘
                                                              │
                                                   Loop de tool-use (API da Claude)
                                                              │
                                        chama funções internas (mesmas do MCP atual):
                                        Bitrix24Reader / Bitrix24Writer
                                                              │
                                                              ▼
                                                   API REST do Bitrix24 (webhook)
```

O Bot Server é um processo HTTP novo e independente do servidor MCP atual (que continua rodando via stdio para uso dentro do Claude Code). Os dois processos compartilham o mesmo código-base em `src/bitrix24/` e `src/tools/`, mas têm entrypoints e ciclos de vida separados: um roda sob demanda dentro de uma sessão Claude Code, o outro roda continuamente no servidor do usuário escutando eventos do Bitrix24.

## Componentes

1. **`src/bot/register.js`** — script executado manualmente uma única vez (ou ao reconfigurar) que chama `imbot.register` no Bitrix24, apontando os eventos `ONIMBOTMESSAGEADD` e `ONIMBOTJOINCHAT` para a URL pública do Bot Server.

2. **`src/bot/server.js`** — servidor HTTP com endpoint `POST /bitrix-events`. Valida o `application_token` enviado pelo Bitrix24 em cada evento e despacha mensagens válidas para o handler.

3. **`src/bot/agent-loop.js`** — núcleo de interpretação. Recebe o texto da mensagem, o histórico curto do chat e a memória de longo prazo do usuário; chama a API da Claude com as ferramentas adaptadas dos schemas `zod` já definidos em `src/tools/*.js`. Decide se a ação é leitura (executa direto) ou escrita (monta resumo e aciona confirmação). Se faltar informação para montar a ação com segurança, pergunta ao usuário em vez de adivinhar.

4. **`src/bot/pending-actions.js`** — armazenamento local (arquivo JSON ou SQLite) das ações aguardando confirmação, chaveado por chat_id, com expiração (10 minutos). Uma pendência expirada é tratada como inexistente na próxima mensagem.

5. **`src/bot/reply.js`** — wrapper sobre `imbot.message.add` para responder no chat correto.

6. **Ferramentas reaproveitadas** — nenhuma duplicação de lógica: `agent-loop.js` importa e chama diretamente as mesmas funções já usadas pelo servidor MCP (`src/tools/crm.js`, `tasks.js`, `calendar.js`, etc.), só que como chamadas de função diretas em vez de via protocolo MCP.

7. **`src/bot/memory.js`** — memória de longo prazo por usuário (chave = ID do usuário no Bitrix24), persistida em disco em formato texto (fato + motivo + como aplicar, no mesmo espírito do sistema de memória do próprio Claude). Distinta do histórico curto de conversa: não expira, e não se mistura entre usuários diferentes.

## Fluxo de dados

### Leitura (ex: "quantos leads entraram essa semana")

1. Bitrix24 envia `ONIMBOTMESSAGEADD` → `server.js` valida o token e repassa o texto para `agent-loop.js`.
2. `agent-loop.js` carrega a memória de longo prazo do usuário e o histórico curto do chat, chama a API da Claude, que decide que é uma consulta e chama a função de leitura correspondente diretamente (ex: `crm.js`, filtro de data).
3. Resultado formatado é enviado de volta via `reply.js`. Fim — sem confirmação.

### Escrita (ex: "cria uma tarefa pro João revisar o contrato até sexta")

1. Mesmo caminho até `agent-loop.js`.
2. Claude identifica ação sensível (cria/edita/exclui dado), monta um resumo em linguagem natural da ação proposta e pergunta confirmação (ex: "sim/não"). O resumo e os parâmetros da ação são gravados em `pending-actions.js` (chat_id → ação serializada + expiração de 10 min).
3. Resposta é enviada ao usuário; o bot aguarda a próxima mensagem daquele chat.
4. Na próxima mensagem do mesmo chat: se existir pendência não expirada, o texto é interpretado primeiro como confirmação/ajuste/recusa.
   - "sim" → executa via `Bitrix24Writer`, responde com o resultado (ex: link do registro criado), limpa a pendência, registra no log de auditoria, e passa a ação executada para avaliação de memória (passo seguinte).
   - "não" ou pedido de ajuste → descarta ou reformula a proposta, sem tocar no Bitrix24.
   - Pendência expirada → a mensagem é tratada como um pedido novo.

### Memória de longo prazo

- **Leitura:** no início de cada chamada a `agent-loop.js`, os fatos gravados para aquele usuário em `memory.js` são injetados no contexto antes da mensagem atual, evitando que o usuário precise repetir informações (departamento padrão de uma pessoa, prazos costumeiros, preferências de nomenclatura, etc.).
- **Escrita:** depois que uma ação é confirmada e executada, ou quando o usuário corrige explicitamente algo que o assistente entendeu errado, `agent-loop.js` avalia se algo ali deve virar um fato durável e acrescenta a `memory.js` (sem duplicar o que já existe).
- **Poda:** como o arquivo de memória cresce com o uso, há um limite de fatos por usuário; ao ultrapassar, os fatos mais antigos/menos usados são resumidos ou removidos, para não estourar o contexto de usuários muito ativos.
- **Histórico curto vs. memória longa:** o histórico de conversa (~10 mensagens) é contexto imediato e expira; a memória de longo prazo persiste indefinidamente em disco, por usuário.

## Permissões

Decisão do usuário: **todos os usuários do portal** podem conversar com o bot e disparar ações — não há lista branca. Como contrapartida, há proteções operacionais (ver seção seguinte), não restrições de acesso.

## Tratamento de erros e segurança

- **Validação de evento:** todo POST em `/bitrix-events` precisa apresentar o `application_token` recebido no registro do bot; requisições sem token válido são descartadas com HTTP 403.
- **Falha ao chamar a API da Claude** (timeout, rate limit): o bot responde no chat informando que não conseguiu processar e sugere tentar novamente — nunca deixa a mensagem sem retorno.
- **Falha na escrita ao Bitrix24:** o erro da API é traduzido em uma resposta legível no chat; a ação pendente correspondente é descartada (não fica "meio executada").
- **Ambiguidade na interpretação:** se `agent-loop.js` não tiver informação suficiente para montar a ação com segurança, pergunta ao usuário em vez de adivinhar, antes de propor confirmação.
- **Rate limit por usuário:** como não há whitelist, um limite simples (ex: 20 mensagens/minuto por usuário) evita loops acidentais ou abuso consumindo a cota da API da Claude. É proteção operacional, não controle de permissão.
- **Log de auditoria:** toda ação de escrita executada (quem pediu, o que foi feito, quando, resultado) é registrada em um log local, permitindo rastrear ações incorretas depois.

## Testes

- **Unitários:** `agent-loop.js` (decisão leitura vs. escrita, montagem do resumo de confirmação, expiração de pendência) e `memory.js` (leitura, escrita, poda de fatos), usando mocks de `Bitrix24Reader`/`Writer` — sem bater no Bitrix24 real.
- **Integração do endpoint:** simula um payload real de `ONIMBOTMESSAGEADD` contra `server.js`, cobrindo token válido e inválido.
- **Fluxo de confirmação ponta a ponta:** duas mensagens seguidas do mesmo chat_id (pedido → "sim"), verificando que a ação só é executada na segunda mensagem, e que a pendência expira corretamente após o tempo configurado.
- **Manual, contra o portal real:** antes de liberar para todos os usuários, testar com um usuário de teste pedindo uma leitura, uma escrita com confirmação, e uma correção que deveria gerar memória — conferindo o log de auditoria.

## Fora de escopo (por ora)

- Bot participando de chats de grupo/equipe (só chat 1:1 nesta primeira versão).
- Interface para o usuário visualizar/editar manualmente sua própria memória (ex: comando "esquece isso") — não foi pedido, pode ser considerado depois.
- Memória compartilhada entre usuários (decisão: memória é sempre por usuário).
- Lista branca de usuários autorizados (decisão: liberado para todos, com proteções operacionais em vez de controle de acesso).
