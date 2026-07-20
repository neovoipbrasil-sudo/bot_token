# Implantação do bot (MSN Talk ↔ Bitrix24) no EasyPanel — Design

Data: 2026-07-20

## Problema

O código do bot Bitrix24 (`src/bot/*`), incluindo a integração MSN Talk ↔
Bitrix24, existe e está testado, mas não roda em lugar nenhum publicamente
acessível. Sem um processo rodando com uma URL HTTPS pública, nem o Bitrix24
(eventos `imbot.v2`) nem o MSN Talk (webhook de conversas) conseguem entregar
eventos, e a integração não tem efeito nenhum na prática.

## Objetivo

Colocar `src/bot/bootstrap.js` rodando de forma permanente, com URL pública
HTTPS, sem depender de mexer manualmente no servidor a cada reinício, e sem
interferir nos outros apps já hospedados neste servidor (`srv1028961`).

## Contexto do servidor

Este servidor (`srv1028961`, Ubuntu 24.04) já roda **EasyPanel** — um PaaS
baseado em Docker + Traefik — hospedando dois outros apps
(`ia_de_propostas`, `app_quilometragem`). O Traefik já está nas portas 80/443
roteando por domínio/subdomínio; não há Nginx solto nem PM2 instalado. Não
existe CLI/API do EasyPanel acessível por este agente — a criação do app no
painel é feita pelo usuário via navegador, seguindo os valores exatos
definidos aqui.

## Arquitetura

Novo app Docker no EasyPanel — independente dos dois já hospedados, sem
compartilhar container nem código com eles:

```
GitHub (bit2beat/bitrix24-mcp, branch main)
        │  (EasyPanel builda a imagem a cada deploy)
        ▼
   Container Docker (Node 18+, roda `node src/bot/bootstrap.js`)
        │
        ▼
   Traefik (já existente) ── HTTPS automático ── domínio *.easypanel.host
        │
        ├── POST /bitrix-events        (eventos do bot Bitrix24, já existente)
        └── POST /msntalk-events/:secret  (integração MSN Talk, este projeto)
```

Volume persistente montado em `src/bot/data/` (audit log, memória de longo
prazo, confirmações pendentes) — sem isso, cada redeploy apaga esse
histórico.

## Componentes

### `Dockerfile` (novo, raiz do repo)

Imagem Node simples: instala dependências de produção, copia o código, expõe
a porta do bot, roda `node src/bot/bootstrap.js`. Não usa multi-stage build —
o projeto não tem etapa de compilação (é JS puro, `type: module`).

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3300
CMD ["node", "src/bot/bootstrap.js"]
```

### `src/bot/bootstrap.js` (modificar)

`bot-config.json` está no `.gitignore` (contém `botId`/`botToken`, segredo),
então não existe dentro da imagem buildada a partir do GitHub. Hoje
`bootstrap.js` só lê esse arquivo:

```js
const botConfig = JSON.parse(readFileSync(new URL('./bot-config.json', import.meta.url), 'utf-8'));
```

Passa a aceitar `BOT_ID`/`BOT_TOKEN` via variável de ambiente como alternativa,
mantendo o arquivo como fallback (útil para quem já roda localmente sem
Docker, sem quebrar o fluxo atual de `register.js`, que grava esse arquivo):

```js
function loadBotConfig() {
  if (process.env.BOT_ID && process.env.BOT_TOKEN) {
    return { botId: Number(process.env.BOT_ID), botToken: process.env.BOT_TOKEN };
  }
  return JSON.parse(readFileSync(new URL('./bot-config.json', import.meta.url), 'utf-8'));
}

const botConfig = loadBotConfig();
```

Se nem o arquivo nem as duas env vars existirem, o `readFileSync` já lança
erro naturalmente (arquivo não encontrado) — comportamento de falha rápida
preservado, sem necessidade de validação extra.

### App no EasyPanel (configuração manual pelo usuário, sem código)

- **Origem:** GitHub, repositório `bit2beat/bitrix24-mcp`, branch `main`.
- **Build:** Dockerfile (detectado automaticamente na raiz do repo).
- **Porta interna:** `3300` (mesma do `EXPOSE` do Dockerfile / `BOT_PORT`).
- **Domínio:** subdomínio automático `*.easypanel.host` gerado pelo painel
  (sem domínio próprio nesta primeira versão).
- **Volume:** monta um volume persistente em `/app/src/bot/data`.
- **Variáveis de ambiente** (preenchidas na aba de env vars do app):

  | Variável | Valor | Observação |
  |---|---|---|
  | `B24_DEFAULT_WEBHOOK` | webhook incoming do Bitrix24 | já usado pelo resto do MCP |
  | `BOT_ID` | preenchido após rodar `register.js` (passo de implantação) | numérico |
  | `BOT_TOKEN` | mesmo valor usado ao rodar `register.js` | string até 40 caracteres |
  | `BOT_PORT` | `3300` | precisa bater com a porta configurada no EasyPanel |
  | `MSNTALK_WEBHOOK_SECRET` | gerado com `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` | usado no path do webhook do MSN Talk |
  | `MSNTALK_TICKET_URL_TEMPLATE` | `https://app.msntalk.neovoip.com.br/atendimento?ticketId={ticketId}` | opcional, mas recomendado |
  | `ANTHROPIC_API_KEY` | chave da Anthropic | usada pelo `agent-loop.js` |

## Passos de implantação (ordem)

1. Aplicar a mudança em `bootstrap.js` e criar o `Dockerfile` (via plano de
   implementação, com teste).
2. Merge `feature/bitrix24-bot-assistente` → `main` localmente, push de
   `main` para `origin` no GitHub.
3. No painel EasyPanel: criar o app apontando pro repo/branch, configurar
   porta, volume e todas as variáveis de ambiente (exceto `BOT_ID`, que ainda
   não existe).
4. Rodar `node src/bot/register.js` **uma vez** — não precisa ser dentro do
   container do EasyPanel, pode ser localmente neste checkout
   (`/root/bitrix24-mcp`), já que o script só fala com a API REST do
   Bitrix24 via `B24_DEFAULT_WEBHOOK` (já configurado no `.env` local). Rodar
   com `BOT_EVENT_HANDLER_URL` apontando para a URL pública que o EasyPanel
   gerou (`https://<subdominio>.easypanel.host/bitrix-events`) e `BOT_TOKEN`
   igual ao que foi colocado na env var do app — isso registra o bot no
   Bitrix24 e imprime o `BOT_ID` no console (o `bot-config.json` que o script
   grava localmente pode ser ignorado, já que o app no EasyPanel vai usar as
   env vars `BOT_ID`/`BOT_TOKEN`, não esse arquivo).
5. Preencher `BOT_ID` na env var do app no EasyPanel e reiniciar o app.
6. Configurar no painel do MSN Talk a URL de webhook:
   `https://<subdominio>.easypanel.host/msntalk-events/<MSNTALK_WEBHOOK_SECRET>`.
7. Enviar uma mensagem de teste no Bitrix24 (chat do bot) e outra numa
   conversa do MSN Talk vinculada a um Lead/Deal aberto, conferindo que
   ambas produzem efeito (resposta do bot / comentário na timeline).

## Testes

- Teste automatizado para a mudança em `bootstrap.js`: como esse arquivo é
  um composition root sem testes hoje (padrão já existente no projeto), a
  lógica de `loadBotConfig()` é extraída para uma função pura testável
  isoladamente (`src/bot/bot-config.js`, com teste unitário cobrindo: env
  vars presentes → usa env vars; env vars ausentes → lê o arquivo; nenhum
  dos dois → propaga o erro do `readFileSync`).
- Sem teste automatizado para o `Dockerfile` em si (não há CI de build de
  imagem neste projeto) — validado manualmente no passo 7 acima.

## Riscos / limitações conhecidas

- A criação do app no painel EasyPanel é manual (sem CLI/API disponível para
  este agente) — os passos 3, 5 e 6 dependem do usuário seguindo o painel
  web com os valores exatos listados aqui.
- `BOT_ID` só existe depois de rodar `register.js` uma vez contra a URL
  pública já ativa — ou seja, o app precisa subir primeiro (mesmo que ainda
  sem `BOT_ID` configurado, o que faria `bootstrap.js` falhar ao iniciar) só
  para existir a URL, depois recebe o `BOT_ID` e reinicia. Esse é um passo de
  "bootstrap do bootstrap" inerente ao desenho já existente do bot (não
  introduzido por este projeto de deploy).
- Sem domínio próprio nesta primeira versão — o subdomínio `*.easypanel.host`
  gerado automaticamente é suficiente para os webhooks funcionarem, mas pode
  mudar se o app for recriado no painel; trocar por domínio próprio fica como
  melhoria futura, fora de escopo aqui.
