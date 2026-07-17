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
Bitrix24 Portal  ──POST evento ONIMBOTV2MESSAGEADD──▶  Bot Server (novo processo Node.js)
        ▲                                                   │
        │  imbot.v2.Chat.Message.send (resposta/confirmação)│
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

1. **`src/bot/register.js`** — script executado manualmente uma única vez (ou ao reconfigurar). **Premissa validada empiricamente em 2026-07-17 contra o portal real:** o `B24_DEFAULT_WEBHOOK` já usado pelo MCP (com o escopo `imbot` habilitado) é suficiente — não é necessária nenhuma aplicação REST local (OAuth, `client_id`/`client_secret`). A API atual é `imbot.v2.*` (a antiga `imbot.register`, testada primeiro, de fato falha via webhook com `ACCESS_DENIED`, mas é deprecated e não é o caminho correto).
   - `register.js` escolhe um `botToken` (string arbitrária, até 40 caracteres — funciona como segredo do bot, não é gerado pelo Bitrix24) e chama `imbot.v2.Bot.register` com `fields.botToken`, `fields.code`, `fields.properties.name`, `fields.type = 'bot'` e `fields.eventMode = 'fetch'` inicialmente, obtendo `botId`.
   - Em seguida chama `imbot.v2.Bot.update` com `botId` + `botToken` + `fields.eventMode = 'webhook'` + `fields.webhookUrl` apontando para a URL pública do Bot Server — isso ativa a entrega dos eventos `ONIMBOTV2*` automaticamente (não é preciso `event.bind` manual).
   - `register.js` persiste `botId` + `botToken` + `webhookUrl` em `src/bot/bot-config.json`, lido por `server.js` e `reply.js`.

2. **`src/bot/server.js`** — servidor HTTP com endpoint `POST /bitrix-events`. Todo evento do Bitrix24 traz, no **nível raiz** do payload, um campo `auth.application_token` (não confundir com `data.bot.auth.application_token`, que é um token OAuth interno do bot e a documentação alerta explicitamente contra usá-lo para validação). `server.js` calcula o valor esperado como `'custom' + botConfig.botToken` (confirmado empiricamente: com `botToken = 'spike_token_12345'`, o valor recebido foi `customspike_token_12345`) e descarta com HTTP 403 qualquer requisição sem correspondência exata.

3. **`src/bot/agent-loop.js`** — núcleo de interpretação. Recebe o texto da mensagem, o histórico curto do chat e a memória de longo prazo do usuário; chama a API da Claude com as ferramentas adaptadas dos schemas `zod` já definidos em `src/tools/*.js`. Decide se a ação é leitura (executa direto) ou escrita (monta resumo e aciona confirmação). Se faltar informação para montar a ação com segurança, pergunta ao usuário em vez de adivinhar.

4. **`src/bot/pending-actions.js`** — armazenamento local (arquivo JSON ou SQLite) das ações aguardando confirmação, chaveado pelo `dialogId` recebido em `data.chat.dialogId` no payload de `ONIMBOTV2MESSAGEADD` (o mesmo valor exigido por `imbot.v2.Chat.Message.send` para responder no chat certo — para chats 1:1 é o ID do usuário, para grupos é `chat{chatId}`), com expiração (10 minutos). Uma pendência expirada é tratada como inexistente na próxima mensagem.

5. **`src/bot/reply.js`** — wrapper sobre `imbot.v2.Chat.Message.send` (parâmetros: `botId`, `botToken`, `dialogId`, `fields.message`) para responder no chat correto.

6. **Ferramentas reaproveitadas** — nenhuma duplicação de lógica: `agent-loop.js` importa e chama diretamente as mesmas funções já usadas pelo servidor MCP (`src/tools/crm.js`, `tasks.js`, `calendar.js`, etc.), só que como chamadas de função diretas em vez de via protocolo MCP.

7. **`src/bot/memory.js`** — memória de longo prazo por usuário (chave = ID do usuário no Bitrix24), persistida em disco em formato texto (fato + motivo + como aplicar, no mesmo espírito do sistema de memória do próprio Claude). Distinta do histórico curto de conversa: não expira, e não se mistura entre usuários diferentes.

## Fluxo de dados

### Leitura (ex: "quantos leads entraram essa semana")

1. Bitrix24 envia `ONIMBOTV2MESSAGEADD` → `server.js` valida o token e repassa o texto para `agent-loop.js`.
2. `agent-loop.js` carrega a memória de longo prazo do usuário e o histórico curto do chat, chama a API da Claude, que decide que é uma consulta e chama a função de leitura correspondente diretamente (ex: `crm.js`, filtro de data).
3. Resultado formatado é enviado de volta via `reply.js`. Fim — sem confirmação.

### Escrita (ex: "cria uma tarefa pro João revisar o contrato até sexta")

1. Mesmo caminho até `agent-loop.js`.
2. Claude identifica ação sensível (cria/edita/exclui dado), monta um resumo em linguagem natural da ação proposta e pergunta confirmação (ex: "sim/não"). O resumo e os parâmetros da ação são gravados em `pending-actions.js` (DIALOG_ID → ação serializada + expiração de 10 min).
3. Resposta é enviada ao usuário; o bot aguarda a próxima mensagem daquele chat.
4. Na próxima mensagem do mesmo chat: se existir pendência não expirada, o texto é primeiro classificado pela Claude em uma de quatro categorias: confirmação, recusa, ajuste, ou **pedido novo não relacionado**. Critério de desempate entre "ajuste" e "pedido novo": se a mensagem se refere ao mesmo registro/entidade da ação pendente (ex: muda um campo dela, como prazo ou destinatário), é ajuste; se menciona uma entidade diferente ou uma intenção sem relação com a ação pendente (ex: pendência é criar tarefa e a mensagem pergunta sobre leads), é pedido novo.
   - "sim"/confirmação → executa via `Bitrix24Writer`, responde com o resultado (ex: link do registro criado), limpa a pendência, registra no log de auditoria, e passa a ação executada para avaliação de memória (passo seguinte).
   - "não" ou pedido de ajuste → descarta ou reformula a proposta, sem tocar no Bitrix24.
   - **Pedido novo não relacionado** (ex: pendência era "criar tarefa" e a mensagem seguinte pergunta algo sobre leads) → a pendência é cancelada, o bot avisa em uma linha ("cancelei a proposta anterior, já que você mudou de assunto") e o texto é processado como um pedido novo desde o passo 1.
   - Pendência expirada → a mensagem é tratada como um pedido novo.

### Memória de longo prazo

- **Leitura:** no início de cada chamada a `agent-loop.js`, os fatos gravados para aquele usuário em `memory.js` são injetados no contexto antes da mensagem atual, evitando que o usuário precise repetir informações (departamento padrão de uma pessoa, prazos costumeiros, preferências de nomenclatura, etc.).
- **Escrita:** ao final de **toda** interação (leitura ou escrita confirmada), ou quando o usuário corrige explicitamente algo que o assistente entendeu errado, `agent-loop.js` avalia se algo ali deve virar um fato durável (ex: um filtro repetido em consultas, um departamento padrão) e acrescenta a `memory.js` (sem duplicar o que já existe). Isso cobre tanto ações de escrita quanto preferências reveladas em consultas de leitura.
- **Poda:** como o arquivo de memória cresce com o uso, há um limite de fatos por usuário; ao ultrapassar, os fatos mais antigos/menos usados são resumidos ou removidos, para não estourar o contexto de usuários muito ativos.
- **Histórico curto vs. memória longa:** o histórico de conversa (~10 mensagens) é contexto imediato e expira; a memória de longo prazo persiste indefinidamente em disco, por usuário.

## Permissões

Decisão do usuário: **todos os usuários do portal** podem conversar com o bot e disparar ações — não há lista branca. Como contrapartida, há proteções operacionais (ver seção seguinte), não restrições de acesso.

### Risco aceito: escalonamento de privilégio

O bot executa toda ação de escrita através do webhook único do `Bitrix24Writer`, que tem seu próprio escopo de permissões (definido pelos scopes habilitados no webhook), **não** as permissões individuais de cada usuário do Bitrix24. Isso significa que um usuário comum pode, através do bot, conseguir executar uma ação que não teria permissão de fazer logado normalmente na interface do Bitrix24 (ex: mover ou excluir um registro de outro departamento).

Dado que a decisão foi liberar o bot para todos os usuários, este é um **risco aceito conscientemente**, mitigado por:
- Confirmação obrigatória antes de qualquer escrita, incluindo exclusões — o resumo apresentado ao usuário antes do "sim" deixa explícito o impacto da ação, inclusive quando é irreversível (seção "Fluxo de dados").
- Log de auditoria completo de toda ação executada (quem pediu, o quê, quando), permitindo reverter manualmente e identificar uso indevido depois do fato.

Uma correção completa desse risco (verificar a permissão real do usuário antes de executar, por exemplo autenticando cada ação com o OAuth individual do usuário em vez do webhook compartilhado) é uma mudança de arquitetura maior, registrada em "Fora de escopo" para avaliação futura.

## Tratamento de erros e segurança

- **Validação de evento:** todo POST em `/bitrix-events` precisa apresentar em `auth.application_token` (nível raiz do payload) o valor `'custom' + botToken`, calculado a partir do `botToken` persistido em `bot-config.json` no momento do registro do bot; requisições sem correspondência exata são descartadas com HTTP 403.
- **Falha ao chamar a API da Claude** (timeout, rate limit): o bot responde no chat informando que não conseguiu processar e sugere tentar novamente — nunca deixa a mensagem sem retorno.
- **Falha na escrita ao Bitrix24:** o erro da API é traduzido em uma resposta legível no chat; a ação pendente correspondente é descartada (não fica "meio executada").
- **Ambiguidade na interpretação:** se `agent-loop.js` não tiver informação suficiente para montar a ação com segurança, pergunta ao usuário em vez de adivinhar, antes de propor confirmação.
- **Rate limit em duas camadas:** um limite por usuário (ex: 20 mensagens/minuto) evita loops acidentais de uma única pessoa; um limite **global** agregado (ex: 200 mensagens/minuto somando todos os usuários) protege a cota da API da Claude e o rate limit da API REST do Bitrix24, que são recursos compartilhados — sem o limite global, muitos usuários abaixo do limite individual ainda poderiam somar tráfego suficiente para esgotar o backend. Ambos os contadores vivem em memória do processo Bot Server (janela de 1 minuto, sem necessidade de persistência); um restart do processo zera os contadores momentaneamente, o que é aceitável para este design porque a janela é curta e restarts não são o vetor de abuso que o limite pretende conter. Ao exceder qualquer um dos dois limites, o bot **sempre responde** (nunca descarta silenciosamente) com uma mensagem curta pedindo para aguardar alguns instantes — mantendo a garantia de que toda mensagem recebe algum retorno. É proteção operacional, não controle de permissão.
- **Log de auditoria:** toda ação de escrita executada (quem pediu, o que foi feito, quando, resultado) é registrada em um log local, permitindo rastrear ações incorretas depois.

## Testes

- **Unitários:** `agent-loop.js` (decisão leitura vs. escrita, montagem do resumo de confirmação, expiração de pendência, e a classificação em 4 categorias — confirmação/recusa/ajuste/pedido novo — incluindo o critério de desempate "mesma entidade vs. entidade diferente" da seção "Fluxo de dados") e `memory.js` (leitura, escrita, poda de fatos), usando mocks de `Bitrix24Reader`/`Writer` — sem bater no Bitrix24 real.
- **Integração do endpoint:** simula um payload real de `ONIMBOTV2MESSAGEADD` contra `server.js`, cobrindo token válido e inválido.
- **Fluxo de confirmação ponta a ponta:** quatro casos com o mesmo DIALOG_ID, cada um partindo de um pedido de escrita pendente —
  1. pedido → "sim": verifica que a ação só é executada na segunda mensagem, e que a pendência expira corretamente após o tempo configurado;
  2. pedido → ajuste (ex: "muda pra segunda-feira"): verifica que a pendência existente é **atualizada** com o novo valor, não recriada do zero, e que uma nova confirmação é pedida antes de executar;
  3. pedido → recusa ("não"): verifica que a proposta é descartada sem tocar no Bitrix24;
  4. pedido → pedido novo não relacionado: verifica que a pendência anterior é cancelada e o novo texto é processado do zero.
- **Manual, contra o portal real:** antes de liberar para todos os usuários, testar com um usuário de teste pedindo uma leitura, uma escrita com confirmação, e uma correção que deveria gerar memória — conferindo o log de auditoria.

## Fora de escopo (por ora)

- Bot participando de chats de grupo/equipe (só chat 1:1 nesta primeira versão).
- Interface para o usuário visualizar/editar manualmente sua própria memória (ex: comando "esquece isso") — não foi pedido, pode ser considerado depois.
- Memória compartilhada entre usuários (decisão: memória é sempre por usuário).
- Lista branca de usuários autorizados (decisão: liberado para todos, com proteções operacionais em vez de controle de acesso).
- Verificação de permissão individual por usuário antes de executar cada ação (ex: autenticar via OAuth do próprio usuário em vez do webhook compartilhado) — resolveria o risco de escalonamento de privilégio descrito em "Permissões", mas é uma mudança de arquitetura maior, fora do escopo desta primeira versão.
