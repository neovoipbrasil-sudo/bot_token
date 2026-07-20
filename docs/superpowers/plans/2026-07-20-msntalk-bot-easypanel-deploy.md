# Implantação do bot (MSN Talk ↔ Bitrix24) no EasyPanel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer `src/bot/bootstrap.js` rodar de forma permanente e publicamente acessível via HTTPS, como um app Docker independente no EasyPanel já rodando neste servidor, sem interferir nos apps já hospedados.

**Architecture:** `bootstrap.js` passa a aceitar `BOT_ID`/`BOT_TOKEN` via variável de ambiente (com fallback pro arquivo `bot-config.json`, que é gitignored e não existe na imagem). Um `Dockerfile` + `.dockerignore` novos na raiz do repo empacotam o processo. O EasyPanel builda essa imagem a partir do GitHub (branch `main`) e expõe via Traefik já existente, com domínio automático `*.easypanel.host`.

**Tech Stack:** Node 20 (imagem `node:20-slim`), Docker, EasyPanel/Traefik (infraestrutura já existente no servidor), Vitest.

## Global Constraints

- `bot-config.json` nunca deve ser adicionado ao Git nem ao Dockerfile — continua gitignored; a alternativa via env var (`BOT_ID`/`BOT_TOKEN`) é o caminho usado em produção.
- Se nem as env vars nem o arquivo existirem, o comportamento deve continuar sendo falha rápida (erro do `readFileSync`, sem try/catch escondendo o problema) — mesmo padrão de falha rápida já usado para `MSNTALK_WEBHOOK_SECRET`.
- `.dockerignore` deve excluir `.git`, `node_modules`, `docs`, `README.md`, `*.test.js` e `vitest.config.js` — sem isso o build (que clona do GitHub) levaria o histórico do repositório inteiro pra imagem.
- Porta interna do container: `3300`, consistente entre `Dockerfile` (`EXPOSE`), `BOT_PORT` (env var) e a config de porta do app no EasyPanel.
- Volume persistente monta em `/app/src/bot/data` (não perder audit log / memória / confirmações pendentes a cada redeploy).
- `B24_DEFAULT_WEBHOOK` não está configurado no `.env` local hoje (só tem `ANTHROPIC_API_KEY`) — precisa ser adicionado antes de rodar `register.js` localmente (passo de implantação, não de código).

---

## File Structure

- `src/bot/bot-config.js` (novo) — `loadBotConfig()`: função pura, lê `BOT_ID`/`BOT_TOKEN` de env var ou faz fallback pro arquivo `bot-config.json`.
- `src/bot/bot-config.test.js` (novo)
- `src/bot/bootstrap.js` (modificar) — troca a leitura direta do arquivo por `loadBotConfig()`.
- `.dockerignore` (novo, raiz do repo)
- `Dockerfile` (novo, raiz do repo)

---

### Task 1: `bot-config.js` — carregar config do bot via env var ou arquivo

**Files:**
- Create: `src/bot/bot-config.js`
- Test: `src/bot/bot-config.test.js`
- Modify: `src/bot/bootstrap.js`

**Interfaces:**
- Produces: `loadBotConfig(): { botId: number, botToken: string }` — lança o erro nativo do `readFileSync` (`ENOENT`) se nem env vars nem arquivo existirem.

- [ ] **Step 1: Write the failing tests**

```js
// src/bot/bot-config.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { loadBotConfig } from './bot-config.js';

const ORIGINAL_ENV = { ...process.env };
let dir;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bot-config-test-'));
  delete process.env.BOT_ID;
  delete process.env.BOT_TOKEN;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

describe('loadBotConfig', () => {
  it('uses BOT_ID/BOT_TOKEN from env vars when both are present, ignoring the file path', () => {
    process.env.BOT_ID = '456';
    process.env.BOT_TOKEN = 'secret-from-env';

    const config = loadBotConfig({ filePath: path.join(dir, 'does-not-exist.json') });

    expect(config).toEqual({ botId: 456, botToken: 'secret-from-env' });
  });

  it('falls back to reading the file when env vars are absent', () => {
    const filePath = path.join(dir, 'bot-config.json');
    writeFileSync(filePath, JSON.stringify({ botId: 789, botToken: 'secret-from-file' }));

    const config = loadBotConfig({ filePath });

    expect(config).toEqual({ botId: 789, botToken: 'secret-from-file' });
  });

  it('falls back to the file when only one of the two env vars is set', () => {
    process.env.BOT_ID = '456';
    const filePath = path.join(dir, 'bot-config.json');
    writeFileSync(filePath, JSON.stringify({ botId: 789, botToken: 'secret-from-file' }));

    const config = loadBotConfig({ filePath });

    expect(config).toEqual({ botId: 789, botToken: 'secret-from-file' });
  });

  it('propagates the readFileSync error when neither env vars nor the file exist', () => {
    const filePath = path.join(dir, 'does-not-exist.json');

    expect(() => loadBotConfig({ filePath })).toThrow(/ENOENT/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/bot/bot-config.test.js`
Expected: FAIL — `Cannot find module './bot-config.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/bot/bot-config.js
import { readFileSync } from 'fs';

export function loadBotConfig({ filePath }) {
  if (process.env.BOT_ID && process.env.BOT_TOKEN) {
    return { botId: Number(process.env.BOT_ID), botToken: process.env.BOT_TOKEN };
  }
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/bot/bot-config.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Wire into `bootstrap.js`**

Em `src/bot/bootstrap.js`, troca a linha:

```js
const botConfig = JSON.parse(readFileSync(new URL('./bot-config.json', import.meta.url), 'utf-8'));
```

por:

```js
const botConfig = loadBotConfig({ filePath: new URL('./bot-config.json', import.meta.url) });
```

E adiciona o import (junto aos outros imports locais já existentes no topo do arquivo):

```js
import { loadBotConfig } from './bot-config.js';
```

`readFileSync` (linha 1 de `bootstrap.js`, `import { readFileSync } from 'fs';`) era usado só nessa linha — remove esse import, já que depois da troca acima não sobra nenhum outro uso dele no arquivo.

- [ ] **Step 6: Rodar a suíte inteira para garantir que nada quebrou**

Run: `npm test`
Expected: PASS (todos os testes existentes + os 4 novos de `bot-config.test.js`)

- [ ] **Step 7: Commit**

```bash
git add src/bot/bot-config.js src/bot/bot-config.test.js src/bot/bootstrap.js
git commit -m "feat(bot): load BOT_ID/BOT_TOKEN from env vars, falling back to bot-config.json"
```

---

### Task 2: `Dockerfile` + `.dockerignore`

**Files:**
- Create: `.dockerignore`
- Create: `Dockerfile`

**Interfaces:**
- Consumes: `src/bot/bootstrap.js` (Task 1) como entrypoint do container.

Esta task não tem teste automatizado (não há CI de build de imagem neste projeto) — é verificada rodando `docker build` localmente neste servidor, que já tem Docker instalado.

- [ ] **Step 1: Criar `.dockerignore`**

```
# .dockerignore
.git
node_modules
docs
README.md
*.test.js
vitest.config.js
```

- [ ] **Step 2: Criar `Dockerfile`**

```dockerfile
# Dockerfile
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3300
CMD ["node", "src/bot/bootstrap.js"]
```

- [ ] **Step 3: Validar o build localmente**

Run: `docker build -t bitrix24-bot-test .`
Expected: build termina com `Successfully tagged bitrix24-bot-test:latest` (ou equivalente do BuildKit), sem erros.

- [ ] **Step 4: Confirmar que o `.dockerignore` está excluindo o esperado**

Run: `docker run --rm bitrix24-bot-test sh -c "ls -la /app && test ! -d /app/.git && test ! -d /app/docs && echo OK"`
Expected: imprime `OK` (confirma que `/app/.git` e `/app/docs` não existem dentro da imagem) — não precisa validar a saída de `ls -la` linha por linha, só que o `echo OK` final foi impresso, o que só acontece se os dois `test !` passarem.

- [ ] **Step 5: Confirmar que o processo sobe (mesmo que falhe depois por falta de config — só queremos ver que o Node inicia e tenta rodar `bootstrap.js`)**

Run: `docker run --rm bitrix24-bot-test node -e "require('fs').accessSync('/app/src/bot/bootstrap.js'); console.log('bootstrap.js presente na imagem')"`
Expected: imprime `bootstrap.js presente na imagem`

- [ ] **Step 6: Remover a imagem de teste local**

Run: `docker rmi bitrix24-bot-test`

- [ ] **Step 7: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "feat(bot): add Dockerfile and .dockerignore for EasyPanel deployment"
```

---

## Passos de implantação (não são tasks de código — runbook manual, executado depois das Tasks 1 e 2)

Estes passos não têm subagente de implementação nem revisão automatizada — envolvem o painel web do EasyPanel (sem CLI/API disponível) e ações que só fazem sentido rodar uma vez, manualmente, na ordem abaixo. Correspondem à seção "Passos de implantação" do spec (`docs/superpowers/specs/2026-07-20-msntalk-bot-easypanel-deploy-design.md`).

1. **Merge e push:**
   ```bash
   git checkout main
   git merge feature/bitrix24-bot-assistente --no-edit
   npm test   # confirma que a suíte inteira passa no resultado do merge
   git push origin main
   ```

2. **Criar o app no EasyPanel** (via navegador, `http://<ip-do-servidor>:3000`):
   - Origem: GitHub, repositório `bit2beat/bitrix24-mcp`, branch `main`.
   - Build: Dockerfile (detectado automaticamente).
   - Porta interna: `3300`.
   - Volume: montar em `/app/src/bot/data`.
   - Variáveis de ambiente (todas exceto `BOT_ID`, que ainda não existe):
     ```
     B24_DEFAULT_WEBHOOK=<webhook incoming do Bitrix24>
     BOT_TOKEN=<escolha uma string até 40 caracteres>
     BOT_PORT=3300
     MSNTALK_WEBHOOK_SECRET=<gerar com o comando abaixo>
     MSNTALK_TICKET_URL_TEMPLATE=https://app.msntalk.neovoip.com.br/atendimento?ticketId={ticketId}
     ANTHROPIC_API_KEY=<chave da Anthropic>
     ```
     Gerar `MSNTALK_WEBHOOK_SECRET`:
     ```bash
     node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
     ```
   - Deploy o app (vai crashar ao iniciar por falta de `BOT_ID` — esperado, é o passo 3 que resolve isso). Anote a URL pública gerada pelo EasyPanel (algo como `https://<nome>.easypanel.host`).

3. **Registrar o bot no Bitrix24** (localmente, neste checkout, não dentro do container):
   ```bash
   # adicionar ao .env local se ainda não estiver lá:
   echo "B24_DEFAULT_WEBHOOK=<mesmo valor usado no EasyPanel>" >> .env

   BOT_EVENT_HANDLER_URL=https://<nome-gerado>.easypanel.host/bitrix-events \
   BOT_TOKEN=<mesmo valor colocado na env var do app no EasyPanel> \
   node src/bot/register.js
   ```
   Copiar o `BOT_ID` numérico impresso no console (o `bot-config.json` gravado localmente por esse comando não é usado em produção — pode ser ignorado).

4. **Completar a env var e reiniciar:** no painel do EasyPanel, preencher `BOT_ID` com o valor do passo 3 e reiniciar o app. Confirmar nos logs do EasyPanel que o processo subiu sem erros (`Bot Server escutando na porta 3300`).

5. **Configurar o webhook no painel do MSN Talk:**
   ```
   https://<nome-gerado>.easypanel.host/msntalk-events/<MSNTALK_WEBHOOK_SECRET>
   ```

6. **Smoke test:**
   - Mandar uma mensagem para o bot no chat do Bitrix24 e confirmar que ele responde.
   - Mandar uma mensagem numa conversa do MSN Talk vinculada a um Lead/Deal aberto no Bitrix24 e confirmar que aparece um comentário `[MSN Talk] Cliente: ...` (ou `SDR:`) na timeline desse registro em até alguns segundos.
   - Mandar uma mensagem de um telefone sem Lead/Deal correspondente e confirmar (via acesso SSH ao volume montado, ou terminal do EasyPanel) que `src/bot/data/audit.jsonl` ganhou uma linha com `result: 'no-match'`.
