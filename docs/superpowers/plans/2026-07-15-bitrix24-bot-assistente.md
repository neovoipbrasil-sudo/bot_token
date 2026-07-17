# Assistente Claude via bot do Bitrix24 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Bot Server (`src/bot/`) that lets any Bitrix24 portal user chat 1:1 with an "Assistente" bot to trigger CRM/Tasks/Calendar actions, interpreted by the Claude API and executed through the same `src/tools/*.js` functions the existing MCP server already uses.

**Architecture:** A new Express HTTP process (`src/bot/server.js`), independent from the stdio MCP server (`index.js`), receives `ONIMBOTV2MESSAGEADD` events, runs a Claude tool-use loop (`src/bot/agent-loop.js`) against a curated subset of the existing tool functions, requires confirmation before any write, and persists per-user long-term memory and per-dialog pending actions as local JSON files.

**Tech Stack:** Node.js (ESM, `"type": "module"`), Express (new dependency) for the HTTP endpoint, `@anthropic-ai/sdk` (new dependency) for the Claude API, `zod-to-json-schema` (new dependency) to convert the existing zod schemas into Claude tool `input_schema`, Vitest (new devDependency — no test framework exists in this repo yet) for unit tests.

## Global Constraints

- Node >=18, ESM only (`"type": "module"` in `package.json`) — every new file uses `import`/`export`, never `require`.
- No whitelist: every portal user may talk to the bot (spec: "Permissões").
- Rate limits: 20 messages/minute per user, 200 messages/minute global, both in-memory with a 1-minute sliding window; exceeding either always sends a reply, never silently drops (spec: "Rate limit em duas camadas").
- Pending confirmations expire after 10 minutes (spec: "Fluxo de dados").
- Memory facts are capped per user; oldest facts are dropped first once the cap is exceeded (spec: "Poda").
- Every executed write action is logged to a local audit log (who, what, when, result) (spec: "Log de auditoria").
- Bot chat channel is 1:1 only — no group chat support in this version (spec: "Fora de escopo").
- `imbot.v2.Bot.register`/`imbot.v2.Bot.update`/`imbot.v2.Chat.Message.send` over the existing `B24_DEFAULT_WEBHOOK`, using a self-chosen `botToken` (no OAuth app) — **validated empirically against the real portal on 2026-07-17** (Task 1 below, superseding an earlier failed test of the deprecated `imbot.register`). Event authenticity is validated via the top-level `auth.application_token`, which equals `'custom' + botToken`.
- Anthropic model id: `claude-sonnet-5`, overridable via `CLAUDE_MODEL` env var. API key read by the SDK from `ANTHROPIC_API_KEY` env var (standard SDK behavior, no code needed for that part).

---

### Task 1: Validate the `imbot.v2.Bot.register` premise against the real portal — DONE

**Status: complete, validated empirically against the real portal on 2026-07-17.** This task's original spike tested only the deprecated `imbot.register`, which really does fail via webhook (`ACCESS_DENIED "Client ID not specified"`) — see commit `d61a32c`. A follow-up spike tested the current `imbot.v2.*` API end-to-end and confirmed it works fully over the existing `B24_DEFAULT_WEBHOOK`, no OAuth app required. The corrected verdict is committed in `src/bot/spike-register.js` (commit `4ffb5a7`).

**Files:**
- `src/bot/spike-register.js` (kept as the validated reference script; Task 12 turns it into the real `register.js`)

**What was validated, end-to-end, against the real portal (`neo-voip.bitrix24.com.br`):**
1. `imbot.v2.Bot.register` with `fields: { code, botToken, properties: { name }, type: 'bot', eventMode: 'fetch' }` (self-chosen `botToken`, string ≤40 chars — not an OAuth client_id/secret) → returns `botId`.
2. `imbot.v2.Bot.update` with `{ botId, botToken, fields: { eventMode: 'webhook', webhookUrl } }` → switches the bot to webhook delivery; no manual `event.bind` needed.
3. A real message sent to the bot triggered `ONIMBOTV2JOINCHAT` and `ONIMBOTV2MESSAGEADD` events, delivered as `application/x-www-form-urlencoded` POSTs to `webhookUrl`.
4. Event authenticity: the **top-level** `auth.application_token` (never `data.bot.auth.application_token`, which is an OAuth token for the bot itself — the docs explicitly warn against using it for validation) equals `'custom' + botToken`. Confirmed literally: `botToken = 'spike_token_12345'` → received `auth[application_token] = 'customspike_token_12345'`.
5. `imbot.v2.Chat.Message.send` with `{ botId, botToken, dialogId, fields: { message } }` → bot reply delivered to the chat successfully.

The spike bot (id 1050) was unregistered from the portal afterward (`imbot.v2.Bot.unregister`); nothing live remains from this task.

**Consequence for every later task in this plan:** all references to `imbot.register`, `imbot.message.add`, `ONIMBOTMESSAGEADD`/`ONIMBOTJOINCHAT`, `app.info`-derived `application_token`, and `DIALOG_ID`/`BOT_ID`/`FROM_USER_ID`/`MESSAGE` payload field names (old API's uppercase style) have been updated in this plan to their `imbot.v2` equivalents: `imbot.v2.Bot.register`/`.update`, `imbot.v2.Chat.Message.send`, `ONIMBOTV2MESSAGEADD`/`ONIMBOTV2JOINCHAT`, `'custom' + botToken`, and `data.chat.dialogId`/`data.user.id`/`data.message.text` (camelCase, nested under `data`, since `imbot.v2` webhook payloads are structured differently from the old flat `data.PARAMS.*` shape).

No further action needed — proceed to Task 2.

---

### Task 2: Bootstrap dependencies and test framework

**Files:**
- Modify: `package.json`
- Create: `vitest.config.js`
- Create: `src/bot/__smoke__.test.js` (deleted in a later task once real tests exist — or left in place as a minimal sanity check; either is fine, this repo has no test convention yet)
- Modify: `.gitignore`

**Interfaces:**
- Produces: `npm test` runs Vitest; every later task's tests run under this setup.

- [ ] **Step 1: Install dependencies**

```bash
cd /root/bitrix24-mcp
npm install express @anthropic-ai/sdk zod-to-json-schema
npm install --save-dev vitest
```

- [ ] **Step 2: Add test script to `package.json`**

Add to the `"scripts"` block (currently only has `"start"`):

```json
"scripts": {
  "start": "node index.js",
  "test": "vitest run"
}
```

- [ ] **Step 3: Create minimal Vitest config**

```js
// vitest.config.js
export default {
  test: {
    environment: 'node',
  },
};
```

- [ ] **Step 4: Write a smoke test to verify the setup works**

```js
// src/bot/__smoke__.test.js
import { describe, it, expect } from 'vitest';

describe('vitest setup', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run it**

Run: `npm test`
Expected: `1 passed`, no errors.

- [ ] **Step 6: Add bot runtime data to `.gitignore`**

Append to `.gitignore` (create the file if it doesn't exist):

```
src/bot/bot-config.json
src/bot/data/
```

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.js src/bot/__smoke__.test.js .gitignore
git commit -m "chore: add express, @anthropic-ai/sdk, zod-to-json-schema, vitest"
```

---

### Task 3: `tool-registry.js` — curated tool list for Claude tool-use

**Files:**
- Create: `src/bot/tool-registry.js`
- Test: `src/bot/tool-registry.test.js`

**Interfaces:**
- Consumes: `crmListSchema, crmList, crmGetSchema, crmGet, crmCreateSchema, crmCreate, crmUpdateSchema, crmUpdate, crmDeleteSchema, crmDelete` from `src/tools/crm.js`; `tasksListSchema, tasksList, tasksCreateSchema, tasksCreate` from `src/tools/tasks.js`; `calendarListSchema, calendarList, calendarCreateSchema, calendarCreate` from `src/tools/calendar.js`.
- Produces: `TOOLS` (array of `{ name: string, description: string, schema: ZodObject, handler: (params) => Promise<object>, sensitive: boolean }`), `toolsForClaude()` → `Array<{ name, description, input_schema }>` (Claude Messages API tool format), `getTool(name: string)` → throws `Error('Unknown tool: ' + name)` if not found, else returns the matching entry from `TOOLS`.

- [ ] **Step 1: Write the failing test**

```js
// src/bot/tool-registry.test.js
import { describe, it, expect } from 'vitest';
import { TOOLS, toolsForClaude, getTool } from './tool-registry.js';

describe('tool-registry', () => {
  it('exposes exactly the curated set of tools', () => {
    const names = TOOLS.map(t => t.name).sort();
    expect(names).toEqual([
      'calendar_create', 'calendar_list',
      'crm_create', 'crm_delete', 'crm_get', 'crm_list', 'crm_update',
      'tasks_create', 'tasks_list',
    ]);
  });

  it('marks write actions as sensitive and read actions as not sensitive', () => {
    expect(getTool('crm_list').sensitive).toBe(false);
    expect(getTool('crm_get').sensitive).toBe(false);
    expect(getTool('tasks_list').sensitive).toBe(false);
    expect(getTool('calendar_list').sensitive).toBe(false);
    expect(getTool('crm_create').sensitive).toBe(true);
    expect(getTool('crm_update').sensitive).toBe(true);
    expect(getTool('crm_delete').sensitive).toBe(true);
    expect(getTool('tasks_create').sensitive).toBe(true);
    expect(getTool('calendar_create').sensitive).toBe(true);
  });

  it('converts every tool into a valid Claude tool definition', () => {
    const claudeTools = toolsForClaude();
    expect(claudeTools).toHaveLength(TOOLS.length);
    for (const t of claudeTools) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(t.input_schema).toBeTypeOf('object');
      expect(t.input_schema.type).toBe('object');
    }
  });

  it('getTool throws a clear error for an unknown tool name', () => {
    expect(() => getTool('does_not_exist')).toThrow('Unknown tool: does_not_exist');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/bot/tool-registry.test.js`
Expected: FAIL — `Cannot find module './tool-registry.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/bot/tool-registry.js
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  crmListSchema, crmList,
  crmGetSchema, crmGet,
  crmCreateSchema, crmCreate,
  crmUpdateSchema, crmUpdate,
  crmDeleteSchema, crmDelete,
} from '../tools/crm.js';
import { tasksListSchema, tasksList, tasksCreateSchema, tasksCreate } from '../tools/tasks.js';
import { calendarListSchema, calendarList, calendarCreateSchema, calendarCreate } from '../tools/calendar.js';

export const TOOLS = [
  { name: 'crm_list', description: 'Lista registros de CRM (leads, deals, contacts, companies) com filtros opcionais. Ação de leitura, não exige confirmação.', schema: crmListSchema, handler: crmList, sensitive: false },
  { name: 'crm_get', description: 'Busca um único registro de CRM pelo ID. Ação de leitura, não exige confirmação.', schema: crmGetSchema, handler: crmGet, sensitive: false },
  { name: 'crm_create', description: 'Cria um novo registro de CRM (lead, deal, contact, company). Ação de escrita, exige confirmação do usuário antes de executar.', schema: crmCreateSchema, handler: crmCreate, sensitive: true },
  { name: 'crm_update', description: 'Atualiza campos de um registro de CRM existente, incluindo mudar de etapa/estágio. Ação de escrita, exige confirmação do usuário antes de executar.', schema: crmUpdateSchema, handler: crmUpdate, sensitive: true },
  { name: 'crm_delete', description: 'Exclui um registro de CRM. Ação de escrita irreversível, exige confirmação explícita do usuário antes de executar.', schema: crmDeleteSchema, handler: crmDelete, sensitive: true },
  { name: 'tasks_list', description: 'Lista tarefas do módulo de Tarefas do Bitrix24 com filtros opcionais. Ação de leitura, não exige confirmação.', schema: tasksListSchema, handler: tasksList, sensitive: false },
  { name: 'tasks_create', description: 'Cria uma nova tarefa. Ação de escrita, exige confirmação do usuário antes de executar.', schema: tasksCreateSchema, handler: tasksCreate, sensitive: true },
  { name: 'calendar_list', description: 'Lista eventos de calendário com filtros opcionais. Ação de leitura, não exige confirmação.', schema: calendarListSchema, handler: calendarList, sensitive: false },
  { name: 'calendar_create', description: 'Cria um novo evento de calendário. Ação de escrita, exige confirmação do usuário antes de executar.', schema: calendarCreateSchema, handler: calendarCreate, sensitive: true },
];

export function toolsForClaude() {
  return TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: zodToJsonSchema(t.schema, { target: 'openApi3', $refStrategy: 'none' }),
  }));
}

export function getTool(name) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/bot/tool-registry.test.js`
Expected: `4 passed`

- [ ] **Step 5: Commit**

```bash
git add src/bot/tool-registry.js src/bot/tool-registry.test.js
git commit -m "feat(bot): add curated tool registry for Claude tool-use"
```

---

### Task 4: `message-rate-limiter.js` — per-user + global sliding window

**Files:**
- Create: `src/bot/message-rate-limiter.js`
- Test: `src/bot/message-rate-limiter.test.js`

**Interfaces:**
- Produces: `createRateLimiter({ perUserLimit = 20, globalLimit = 200, windowMs = 60_000, now = () => Date.now() } = {})` → `{ checkAndConsume(userId: string) => { allowed: boolean, scope?: 'user' | 'global' } }`. `now` is injectable so tests can control time without real waiting.

- [ ] **Step 1: Write the failing test**

```js
// src/bot/message-rate-limiter.test.js
import { describe, it, expect } from 'vitest';
import { createRateLimiter } from './message-rate-limiter.js';

describe('message-rate-limiter', () => {
  it('allows messages under the per-user limit', () => {
    const limiter = createRateLimiter({ perUserLimit: 2, globalLimit: 100 });
    expect(limiter.checkAndConsume('user-1').allowed).toBe(true);
    expect(limiter.checkAndConsume('user-1').allowed).toBe(true);
  });

  it('blocks a user that exceeds the per-user limit, without touching other users', () => {
    const limiter = createRateLimiter({ perUserLimit: 2, globalLimit: 100 });
    limiter.checkAndConsume('user-1');
    limiter.checkAndConsume('user-1');
    const third = limiter.checkAndConsume('user-1');
    expect(third).toEqual({ allowed: false, scope: 'user' });
    expect(limiter.checkAndConsume('user-2').allowed).toBe(true);
  });

  it('blocks everyone once the global limit is hit, even if no single user exceeded their own limit', () => {
    const limiter = createRateLimiter({ perUserLimit: 20, globalLimit: 2 });
    limiter.checkAndConsume('user-1');
    limiter.checkAndConsume('user-2');
    const third = limiter.checkAndConsume('user-3');
    expect(third).toEqual({ allowed: false, scope: 'global' });
  });

  it('resets the per-user window after windowMs elapses', () => {
    let currentTime = 1000;
    const limiter = createRateLimiter({ perUserLimit: 1, globalLimit: 100, windowMs: 60_000, now: () => currentTime });
    expect(limiter.checkAndConsume('user-1').allowed).toBe(true);
    expect(limiter.checkAndConsume('user-1').allowed).toBe(false);
    currentTime += 60_001;
    expect(limiter.checkAndConsume('user-1').allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/bot/message-rate-limiter.test.js`
Expected: FAIL — `Cannot find module './message-rate-limiter.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/bot/message-rate-limiter.js
export function createRateLimiter({ perUserLimit = 20, globalLimit = 200, windowMs = 60_000, now = () => Date.now() } = {}) {
  const userCounters = new Map();
  let globalCounter = { count: 0, windowStart: now() };

  function resetIfExpired(counter) {
    const t = now();
    if (t - counter.windowStart >= windowMs) {
      counter.count = 0;
      counter.windowStart = t;
    }
    return counter;
  }

  return {
    checkAndConsume(userId) {
      resetIfExpired(globalCounter);

      let user = userCounters.get(userId);
      if (!user) {
        user = { count: 0, windowStart: now() };
        userCounters.set(userId, user);
      }
      resetIfExpired(user);

      if (user.count >= perUserLimit) return { allowed: false, scope: 'user' };
      if (globalCounter.count >= globalLimit) return { allowed: false, scope: 'global' };

      user.count += 1;
      globalCounter.count += 1;
      return { allowed: true };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/bot/message-rate-limiter.test.js`
Expected: `4 passed`

- [ ] **Step 5: Commit**

```bash
git add src/bot/message-rate-limiter.js src/bot/message-rate-limiter.test.js
git commit -m "feat(bot): add per-user + global message rate limiter"
```

---

### Task 5: `audit-log.js` — append-only JSONL log of executed actions

**Files:**
- Create: `src/bot/audit-log.js`
- Test: `src/bot/audit-log.test.js`

**Interfaces:**
- Produces: `createAuditLog(filePath: string)` → `{ logAction({ userId, dialogId, tool, params, result, timestamp = new Date().toISOString() }) => void, readAll() => Array<object> }` (`readAll` is test-only convenience, reads and parses every JSONL line back).

- [ ] **Step 1: Write the failing test**

```js
// src/bot/audit-log.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createAuditLog } from './audit-log.js';

let dir;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'audit-log-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('audit-log', () => {
  it('appends a JSON line per logged action', () => {
    const log = createAuditLog(path.join(dir, 'audit.jsonl'));
    log.logAction({ userId: 'u1', dialogId: 'd1', tool: 'crm_create', params: { fields: { TITLE: 'x' } }, result: { created_id: 42 } });
    log.logAction({ userId: 'u2', dialogId: 'd2', tool: 'tasks_create', params: {}, result: { created_id: 1 } });

    const entries = log.readAll();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ userId: 'u1', tool: 'crm_create' });
    expect(entries[1]).toMatchObject({ userId: 'u2', tool: 'tasks_create' });
    expect(typeof entries[0].timestamp).toBe('string');
  });

  it('creates the file if it does not exist yet', () => {
    const log = createAuditLog(path.join(dir, 'nested', 'audit.jsonl'));
    log.logAction({ userId: 'u1', dialogId: 'd1', tool: 'crm_list', params: {}, result: {} });
    expect(log.readAll()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/bot/audit-log.test.js`
Expected: FAIL — `Cannot find module './audit-log.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/bot/audit-log.js
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

export function createAuditLog(filePath) {
  function ensureDir() {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  return {
    logAction({ userId, dialogId, tool, params, result, timestamp = new Date().toISOString() }) {
      ensureDir();
      const line = JSON.stringify({ userId, dialogId, tool, params, result, timestamp });
      appendFileSync(filePath, line + '\n', 'utf-8');
    },
    readAll() {
      if (!existsSync(filePath)) return [];
      return readFileSync(filePath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/bot/audit-log.test.js`
Expected: `2 passed`

- [ ] **Step 5: Commit**

```bash
git add src/bot/audit-log.js src/bot/audit-log.test.js
git commit -m "feat(bot): add JSONL audit log for executed actions"
```

---

### Task 6: `pending-actions.js` — DIALOG_ID-keyed confirmation store with TTL

**Files:**
- Create: `src/bot/pending-actions.js`
- Test: `src/bot/pending-actions.test.js`

**Interfaces:**
- Produces: `createPendingActionsStore({ filePath, ttlMs = 10 * 60_000, now = () => Date.now() })` → `{ setPending(dialogId, action) => void, getPending(dialogId) => object | null, clearPending(dialogId) => void }`. `action` is an arbitrary JSON-serializable object (the caller — `agent-loop.js` — decides its shape: `{ tool, params, summary }`). `getPending` returns `null` and clears the entry if it has expired.

- [ ] **Step 1: Write the failing test**

```js
// src/bot/pending-actions.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createPendingActionsStore } from './pending-actions.js';

let dir;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'pending-actions-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('pending-actions', () => {
  it('stores and retrieves a pending action by DIALOG_ID', () => {
    const store = createPendingActionsStore({ filePath: path.join(dir, 'pending.json') });
    store.setPending('dialog-1', { tool: 'crm_create', params: { fields: { TITLE: 'x' } }, summary: 'Criar lead X' });
    expect(store.getPending('dialog-1')).toMatchObject({ tool: 'crm_create', summary: 'Criar lead X' });
  });

  it('returns null for a DIALOG_ID with no pending action', () => {
    const store = createPendingActionsStore({ filePath: path.join(dir, 'pending.json') });
    expect(store.getPending('unknown')).toBeNull();
  });

  it('expires a pending action after ttlMs and returns null', () => {
    let currentTime = 1000;
    const store = createPendingActionsStore({ filePath: path.join(dir, 'pending.json'), ttlMs: 1000, now: () => currentTime });
    store.setPending('dialog-1', { tool: 'crm_create', params: {}, summary: 'x' });
    currentTime += 1001;
    expect(store.getPending('dialog-1')).toBeNull();
  });

  it('clearPending removes the entry immediately', () => {
    const store = createPendingActionsStore({ filePath: path.join(dir, 'pending.json') });
    store.setPending('dialog-1', { tool: 'crm_create', params: {}, summary: 'x' });
    store.clearPending('dialog-1');
    expect(store.getPending('dialog-1')).toBeNull();
  });

  it('persists across store instances pointed at the same file', () => {
    const filePath = path.join(dir, 'pending.json');
    const storeA = createPendingActionsStore({ filePath });
    storeA.setPending('dialog-1', { tool: 'crm_create', params: {}, summary: 'x' });

    const storeB = createPendingActionsStore({ filePath });
    expect(storeB.getPending('dialog-1')).toMatchObject({ tool: 'crm_create' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/bot/pending-actions.test.js`
Expected: FAIL — `Cannot find module './pending-actions.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/bot/pending-actions.js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

export function createPendingActionsStore({ filePath, ttlMs = 10 * 60_000, now = () => Date.now() }) {
  function ensureDir() {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  function load() {
    if (!existsSync(filePath)) return {};
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  }

  function persist(data) {
    ensureDir();
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  return {
    setPending(dialogId, action) {
      const data = load();
      data[dialogId] = { action, createdAt: now() };
      persist(data);
    },

    getPending(dialogId) {
      const data = load();
      const entry = data[dialogId];
      if (!entry) return null;
      if (now() - entry.createdAt >= ttlMs) {
        delete data[dialogId];
        persist(data);
        return null;
      }
      return entry.action;
    },

    clearPending(dialogId) {
      const data = load();
      delete data[dialogId];
      persist(data);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/bot/pending-actions.test.js`
Expected: `5 passed`

- [ ] **Step 5: Commit**

```bash
git add src/bot/pending-actions.js src/bot/pending-actions.test.js
git commit -m "feat(bot): add DIALOG_ID-keyed pending confirmation store with TTL"
```

---

### Task 7: `memory.js` — per-user long-term fact store with pruning

**Files:**
- Create: `src/bot/memory.js`
- Test: `src/bot/memory.test.js`

**Interfaces:**
- Produces: `createMemoryStore({ dataDir, maxFactsPerUser = 50 })` → `{ loadFacts(userId) => Array<{ fact: string, reason: string, howToApply: string, addedAt: string }>, appendFact(userId, { fact, reason, howToApply }) => void }`. `appendFact` is a no-op (does not duplicate) if an entry with the exact same `fact` string already exists for that user. When appending would exceed `maxFactsPerUser`, the oldest fact(s) are dropped first.

- [ ] **Step 1: Write the failing test**

```js
// src/bot/memory.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createMemoryStore } from './memory.js';

let dir;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'memory-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('memory', () => {
  it('starts empty for a user with no memory yet', () => {
    const store = createMemoryStore({ dataDir: dir });
    expect(store.loadFacts('user-1')).toEqual([]);
  });

  it('appends a fact and loads it back with a timestamp', () => {
    const store = createMemoryStore({ dataDir: dir });
    store.appendFact('user-1', { fact: 'Prefere prazos às sextas', reason: 'disse isso duas vezes', howToApply: 'sugerir sexta como prazo padrão' });
    const facts = store.loadFacts('user-1');
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ fact: 'Prefere prazos às sextas' });
    expect(typeof facts[0].addedAt).toBe('string');
  });

  it('does not duplicate an identical fact for the same user', () => {
    const store = createMemoryStore({ dataDir: dir });
    store.appendFact('user-1', { fact: 'X', reason: 'r', howToApply: 'h' });
    store.appendFact('user-1', { fact: 'X', reason: 'r2', howToApply: 'h2' });
    expect(store.loadFacts('user-1')).toHaveLength(1);
  });

  it('keeps facts of different users separate', () => {
    const store = createMemoryStore({ dataDir: dir });
    store.appendFact('user-1', { fact: 'A', reason: 'r', howToApply: 'h' });
    store.appendFact('user-2', { fact: 'B', reason: 'r', howToApply: 'h' });
    expect(store.loadFacts('user-1')).toHaveLength(1);
    expect(store.loadFacts('user-2')).toHaveLength(1);
    expect(store.loadFacts('user-1')[0].fact).toBe('A');
  });

  it('drops the oldest fact once maxFactsPerUser is exceeded', () => {
    const store = createMemoryStore({ dataDir: dir, maxFactsPerUser: 2 });
    store.appendFact('user-1', { fact: 'first', reason: 'r', howToApply: 'h' });
    store.appendFact('user-1', { fact: 'second', reason: 'r', howToApply: 'h' });
    store.appendFact('user-1', { fact: 'third', reason: 'r', howToApply: 'h' });
    const facts = store.loadFacts('user-1');
    expect(facts).toHaveLength(2);
    expect(facts.map(f => f.fact)).toEqual(['second', 'third']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/bot/memory.test.js`
Expected: FAIL — `Cannot find module './memory.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/bot/memory.js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

export function createMemoryStore({ dataDir, maxFactsPerUser = 50 }) {
  function filePathFor(userId) {
    return path.join(dataDir, 'memory', `${userId}.json`);
  }

  function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  return {
    loadFacts(userId) {
      const filePath = filePathFor(userId);
      if (!existsSync(filePath)) return [];
      return JSON.parse(readFileSync(filePath, 'utf-8'));
    },

    appendFact(userId, { fact, reason, howToApply }) {
      const filePath = filePathFor(userId);
      const facts = this.loadFacts(userId);

      if (facts.some(f => f.fact === fact)) return;

      facts.push({ fact, reason, howToApply, addedAt: new Date().toISOString() });
      while (facts.length > maxFactsPerUser) facts.shift();

      ensureDir(filePath);
      writeFileSync(filePath, JSON.stringify(facts, null, 2), 'utf-8');
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/bot/memory.test.js`
Expected: `5 passed`

- [ ] **Step 5: Commit**

```bash
git add src/bot/memory.js src/bot/memory.test.js
git commit -m "feat(bot): add per-user long-term memory store with pruning"
```

---

### Task 8: `reply.js` — send a message back to a Bitrix24 dialog

**Files:**
- Create: `src/bot/reply.js`
- Test: `src/bot/reply.test.js`

**Interfaces:**
- Consumes: an injected `client` object shaped like `Bitrix24Client` (`{ call(method, params) => Promise<{ result }> }`).
- Produces: `createReplyer({ client, botId, botToken }) => { reply(dialogId, message) => Promise<void> }`.

- [ ] **Step 1: Write the failing test**

```js
// src/bot/reply.test.js
import { describe, it, expect, vi } from 'vitest';
import { createReplyer } from './reply.js';

describe('reply', () => {
  it('calls imbot.v2.Chat.Message.send with the bot id, bot token, dialog id and message', async () => {
    const client = { call: vi.fn().mockResolvedValue({ result: { id: 123 } }) };
    const { reply } = createReplyer({ client, botId: 456, botToken: 'my_bot_token' });

    await reply('dialog-42', 'Olá, tudo certo!');

    expect(client.call).toHaveBeenCalledWith('imbot.v2.Chat.Message.send', {
      botId: 456,
      botToken: 'my_bot_token',
      dialogId: 'dialog-42',
      fields: { message: 'Olá, tudo certo!' },
    });
  });

  it('propagates errors from the client so callers can handle them', async () => {
    const client = { call: vi.fn().mockRejectedValue(new Error('Bitrix24 error [1]: boom')) };
    const { reply } = createReplyer({ client, botId: 456, botToken: 'my_bot_token' });

    await expect(reply('dialog-42', 'oi')).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/bot/reply.test.js`
Expected: FAIL — `Cannot find module './reply.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/bot/reply.js
export function createReplyer({ client, botId, botToken }) {
  return {
    async reply(dialogId, message) {
      return client.call('imbot.v2.Chat.Message.send', {
        botId,
        botToken,
        dialogId,
        fields: { message },
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/bot/reply.test.js`
Expected: `2 passed`

- [ ] **Step 5: Commit**

```bash
git add src/bot/reply.js src/bot/reply.test.js
git commit -m "feat(bot): add reply() wrapper over imbot.v2.Chat.Message.send"
```

---

### Task 9: `agent-loop.js` — pending confirmation classification (sim/recusa/ajuste/pedido novo)

**Files:**
- Create: `src/bot/agent-loop.js`
- Test: `src/bot/agent-loop.test.js`

**Interfaces:**
- Consumes: `getTool(name)` from `./tool-registry.js`; a `pendingActions` object shaped like `createPendingActionsStore(...)`'s return value; a `memory` object shaped like `createMemoryStore(...)`'s return value; an `auditLog` object shaped like `createAuditLog(...)`'s return value; an injected `anthropic` object shaped like `{ messages: { create(params) => Promise<AnthropicResponse> } }` (the real `@anthropic-ai/sdk` client satisfies this shape).
- Produces: `createAgentLoop({ anthropic, pendingActions, memory, auditLog, model = 'claude-sonnet-5' })` → `{ handleMessage({ userId, dialogId, text }) => Promise<{ replies: string[] }> }`. This task implements only the branch where a pending action already exists for `dialogId`; Task 10 adds the "no pending action" branch in the same file/function.

This task's implementation calls `anthropic.messages.create` **once** to classify the user's reply against the pending action. The classification prompt asks Claude to answer with a strict JSON object so the code can parse it deterministically: `{ "category": "confirm" | "refuse" | "adjust" | "new_request", "updatedParams": object | null }`.

- [ ] **Step 1: Write the failing test**

```js
// src/bot/agent-loop.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAgentLoop } from './agent-loop.js';

function fakeStores() {
  const pendingData = new Map();
  const memoryFacts = new Map();
  const auditEntries = [];
  return {
    pendingActions: {
      getPending: vi.fn(dialogId => pendingData.get(dialogId) ?? null),
      setPending: vi.fn((dialogId, action) => pendingData.set(dialogId, action)),
      clearPending: vi.fn(dialogId => pendingData.delete(dialogId)),
    },
    memory: {
      loadFacts: vi.fn(() => []),
      appendFact: vi.fn(),
    },
    auditLog: {
      logAction: vi.fn(),
    },
    _pendingData: pendingData,
  };
}

function claudeJsonResponse(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], stop_reason: 'end_turn' };
}

describe('agent-loop — pending confirmation branch', () => {
  let stores;
  beforeEach(() => { stores = fakeStores(); });

  it('executes the pending tool and clears it when the user confirms', async () => {
    stores._pendingData.set('dialog-1', { tool: 'crm_create', params: { entity: 'lead', fields: { TITLE: 'Novo lead' } }, summary: 'Criar lead "Novo lead"' });

    const anthropic = { messages: { create: vi.fn() } };
    anthropic.messages.create
      .mockResolvedValueOnce(claudeJsonResponse({ category: 'confirm', updatedParams: null }))
      .mockResolvedValueOnce(claudeJsonResponse({ fact: null }));

    const executedTool = vi.fn().mockResolvedValue({ created_id: 99 });
    const loop = createAgentLoop({ anthropic, ...stores, toolExecutor: executedTool });

    const { replies } = await loop.handleMessage({ userId: 'u1', dialogId: 'dialog-1', text: 'sim' });

    expect(executedTool).toHaveBeenCalledWith('crm_create', { entity: 'lead', fields: { TITLE: 'Novo lead' } });
    expect(stores.pendingActions.clearPending).toHaveBeenCalledWith('dialog-1');
    expect(stores.auditLog.logAction).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', dialogId: 'dialog-1', tool: 'crm_create' }));
    expect(replies.join(' ')).toMatch(/99/);
  });

  it('discards the pending action without executing anything when the user refuses', async () => {
    stores._pendingData.set('dialog-1', { tool: 'crm_create', params: {}, summary: 'Criar lead X' });

    const anthropic = { messages: { create: vi.fn().mockResolvedValue(claudeJsonResponse({ category: 'refuse', updatedParams: null })) } };
    const executedTool = vi.fn();
    const loop = createAgentLoop({ anthropic, ...stores, toolExecutor: executedTool });

    const { replies } = await loop.handleMessage({ userId: 'u1', dialogId: 'dialog-1', text: 'não, deixa pra lá' });

    expect(executedTool).not.toHaveBeenCalled();
    expect(stores.pendingActions.clearPending).toHaveBeenCalledWith('dialog-1');
    expect(replies).toHaveLength(1);
  });

  it('updates the pending action in place and asks for confirmation again on adjust', async () => {
    stores._pendingData.set('dialog-1', { tool: 'tasks_create', params: { fields: { TITLE: 'Revisar contrato', DEADLINE: '2026-07-17' } }, summary: 'Criar tarefa com prazo sexta' });

    const anthropic = { messages: { create: vi.fn().mockResolvedValue(claudeJsonResponse({
      category: 'adjust',
      updatedParams: { fields: { TITLE: 'Revisar contrato', DEADLINE: '2026-07-20' } },
    })) } };
    const executedTool = vi.fn();
    const loop = createAgentLoop({ anthropic, ...stores, toolExecutor: executedTool });

    const { replies } = await loop.handleMessage({ userId: 'u1', dialogId: 'dialog-1', text: 'muda pra segunda' });

    expect(executedTool).not.toHaveBeenCalled();
    expect(stores.pendingActions.setPending).toHaveBeenCalledWith('dialog-1', expect.objectContaining({
      tool: 'tasks_create',
      params: { fields: { TITLE: 'Revisar contrato', DEADLINE: '2026-07-20' } },
    }));
    expect(replies[0]).toMatch(/2026-07-20|confirma/i);
  });

  it('cancels the pending action and reprocesses the message as a new request', async () => {
    stores._pendingData.set('dialog-1', { tool: 'tasks_create', params: {}, summary: 'Criar tarefa X' });

    const anthropic = { messages: { create: vi.fn() } };
    anthropic.messages.create.mockResolvedValueOnce(claudeJsonResponse({ category: 'new_request', updatedParams: null }));

    const loop = createAgentLoop({ anthropic, ...stores, toolExecutor: vi.fn() });
    loop._handleNewRequest = vi.fn().mockResolvedValue({ replies: ['Aqui está o que você pediu.'] });

    const { replies } = await loop.handleMessage({ userId: 'u1', dialogId: 'dialog-1', text: 'esquece isso, quantos leads entraram essa semana?' });

    expect(stores.pendingActions.clearPending).toHaveBeenCalledWith('dialog-1');
    expect(loop._handleNewRequest).toHaveBeenCalledWith({ userId: 'u1', dialogId: 'dialog-1', text: 'esquece isso, quantos leads entraram essa semana?' });
    expect(replies[0]).toMatch(/cancelei/i);
    expect(replies[1]).toBe('Aqui está o que você pediu.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/bot/agent-loop.test.js`
Expected: FAIL — `Cannot find module './agent-loop.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/bot/agent-loop.js
import { getTool } from './tool-registry.js';

const CLASSIFY_SYSTEM_PROMPT = `Você classifica a resposta de um usuário a uma proposta de ação pendente no Bitrix24.
Responda APENAS com um JSON válido, sem texto ao redor, no formato:
{"category": "confirm" | "refuse" | "adjust" | "new_request", "updatedParams": <objeto com os parâmetros atualizados da ação, no mesmo formato dos parâmetros originais, ou null>}

Regras:
- "confirm": o usuário concorda em executar a ação como proposta (ex: "sim", "pode", "confirma").
- "refuse": o usuário não quer executar a ação (ex: "não", "deixa pra lá", "cancela").
- "adjust": o usuário quer mudar um detalhe da MESMA ação/entidade (ex: outro prazo, outro responsável). Inclua em "updatedParams" os parâmetros já com o ajuste aplicado.
- "new_request": o usuário mudou de assunto — menciona uma entidade diferente ou uma intenção sem relação com a ação pendente.`;

function extractJson(response) {
  const textBlock = response.content.find(b => b.type === 'text');
  return JSON.parse(textBlock.text);
}

export function createAgentLoop({ anthropic, pendingActions, memory, auditLog, model = 'claude-sonnet-5', toolExecutor }) {
  async function executeTool(name, params) {
    if (toolExecutor) return toolExecutor(name, params);
    return getTool(name).handler(params);
  }

  async function evaluateMemory({ userId, interactionSummary }) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 300,
      system: 'Você decide se uma interação revelou um fato durável sobre o usuário que vale lembrar para o futuro (ex: preferências, padrões repetidos). Responda APENAS com JSON: {"fact": string | null, "reason": string, "howToApply": string}. Use fact: null se não houver nada digno de nota.',
      messages: [{ role: 'user', content: interactionSummary }],
    });
    const parsed = extractJson(response);
    if (parsed.fact) {
      memory.appendFact(userId, { fact: parsed.fact, reason: parsed.reason, howToApply: parsed.howToApply });
    }
  }

  async function handlePending({ userId, dialogId, text, pending }) {
    const classifyResponse = await anthropic.messages.create({
      model,
      max_tokens: 500,
      system: CLASSIFY_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Ação pendente: ${pending.summary}\nParâmetros atuais: ${JSON.stringify(pending.params)}\nResposta do usuário: "${text}"`,
      }],
    });
    const { category, updatedParams } = extractJson(classifyResponse);

    if (category === 'confirm') {
      const result = await executeTool(pending.tool, pending.params);
      pendingActions.clearPending(dialogId);
      auditLog.logAction({ userId, dialogId, tool: pending.tool, params: pending.params, result });
      await evaluateMemory({ userId, interactionSummary: `Usuário confirmou e o assistente executou: ${pending.summary}. Resultado: ${JSON.stringify(result)}.` });
      return { replies: [`Feito! ${JSON.stringify(result)}`] };
    }

    if (category === 'refuse') {
      pendingActions.clearPending(dialogId);
      return { replies: ['Ok, cancelado.'] };
    }

    if (category === 'adjust') {
      const updated = { tool: pending.tool, params: updatedParams ?? pending.params, summary: pending.summary };
      pendingActions.setPending(dialogId, updated);
      return { replies: [`Atualizei a proposta: ${JSON.stringify(updated.params)}. Confirma? (sim/não)`] };
    }

    // category === 'new_request'
    pendingActions.clearPending(dialogId);
    const newRequestResult = await handleNewRequest({ userId, dialogId, text });
    return { replies: ['Cancelei a proposta anterior, já que você mudou de assunto.', ...newRequestResult.replies] };
  }

  async function handleNewRequest({ userId, dialogId, text }) {
    // Implemented in Task 10.
    throw new Error('handleNewRequest not implemented yet');
  }

  const loop = {
    async handleMessage({ userId, dialogId, text }) {
      const pending = pendingActions.getPending(dialogId);
      if (pending) {
        return handlePending({ userId, dialogId, text, pending });
      }
      return loop._handleNewRequest({ userId, dialogId, text });
    },
    _handleNewRequest: handleNewRequest,
  };

  return loop;
}
```

Note: `handlePending` calls the module-level `handleNewRequest` closure directly (not `loop._handleNewRequest`) so that the "new_request" branch always runs the real implementation in production; the test overrides `loop._handleNewRequest` only to isolate the pending-branch behavior from the not-yet-implemented new-request branch. Task 10 replaces the `throw` in `handleNewRequest` with the real implementation — once that lands, `handlePending`'s internal call to `handleNewRequest` starts working end-to-end automatically because it's the same function reference `loop._handleNewRequest` points to.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/bot/agent-loop.test.js`
Expected: `4 passed`

- [ ] **Step 5: Commit**

```bash
git add src/bot/agent-loop.js src/bot/agent-loop.test.js
git commit -m "feat(bot): add pending-confirmation classification to agent-loop"
```

---

### Task 10: `agent-loop.js` — tool-use loop for new requests + memory extraction on reads

**Files:**
- Modify: `src/bot/agent-loop.js` (replace the `handleNewRequest` stub from Task 9)
- Modify: `src/bot/agent-loop.test.js` (add new-request test cases)

**Interfaces:**
- Consumes: `toolsForClaude()` from `./tool-registry.js` (added to this task's imports).
- Produces: same `handleMessage` signature as Task 9; `handleNewRequest` now fully implemented instead of throwing.

- [ ] **Step 1: Write the failing tests (append to the existing file)**

```js
// append to src/bot/agent-loop.test.js

describe('agent-loop — new request branch', () => {
  let stores;
  beforeEach(() => { stores = fakeStores(); });

  it('executes a read tool directly and replies with the result, no confirmation needed', async () => {
    const anthropic = { messages: { create: vi.fn() } };
    anthropic.messages.create
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'call_1', name: 'crm_list', input: { entity: 'lead' } }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Entraram 5 leads essa semana.' }],
      })
      .mockResolvedValueOnce(claudeJsonResponse({ fact: null }));

    const executedTool = vi.fn().mockResolvedValue({ count: 5, items: [] });
    const loop = createAgentLoop({ anthropic, ...stores, toolExecutor: executedTool });

    const { replies } = await loop.handleMessage({ userId: 'u1', dialogId: 'dialog-1', text: 'quantos leads entraram essa semana?' });

    expect(executedTool).toHaveBeenCalledWith('crm_list', { entity: 'lead' });
    expect(stores.pendingActions.setPending).not.toHaveBeenCalled();
    expect(replies).toEqual(['Entraram 5 leads essa semana.']);
  });

  it('does not execute a sensitive tool directly — sets a pending action and asks for confirmation', async () => {
    const anthropic = { messages: { create: vi.fn() } };
    anthropic.messages.create.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Vou criar a tarefa "Revisar contrato" para o João, prazo sexta.' },
        { type: 'tool_use', id: 'call_1', name: 'tasks_create', input: { fields: { TITLE: 'Revisar contrato', RESPONSIBLE_ID: 7, DEADLINE: '2026-07-17' } } },
      ],
    });

    const executedTool = vi.fn();
    const loop = createAgentLoop({ anthropic, ...stores, toolExecutor: executedTool });

    const { replies } = await loop.handleMessage({ userId: 'u1', dialogId: 'dialog-1', text: 'cria uma tarefa pro João revisar o contrato até sexta' });

    expect(executedTool).not.toHaveBeenCalled();
    expect(stores.pendingActions.setPending).toHaveBeenCalledWith('dialog-1', expect.objectContaining({
      tool: 'tasks_create',
      params: { fields: { TITLE: 'Revisar contrato', RESPONSIBLE_ID: 7, DEADLINE: '2026-07-17' } },
    }));
    expect(replies[0]).toMatch(/confirma|sim.*não/i);
  });

  it('injects the user long-term memory facts into the system prompt', async () => {
    stores.memory.loadFacts = vi.fn(() => [{ fact: 'Tarefas do João vão para o departamento Comercial', reason: 'r', howToApply: 'h', addedAt: 'now' }]);

    const anthropic = { messages: { create: vi.fn().mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }) } };
    const loop = createAgentLoop({ anthropic, ...stores, toolExecutor: vi.fn() });

    await loop.handleMessage({ userId: 'u1', dialogId: 'dialog-1', text: 'oi' });

    const firstCallArgs = anthropic.messages.create.mock.calls[0][0];
    expect(firstCallArgs.system).toMatch(/Departamento Comercial|departamento Comercial/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/bot/agent-loop.test.js`
Expected: FAIL — `Error: handleNewRequest not implemented yet`

- [ ] **Step 3: Replace the stub with the real implementation**

In `src/bot/agent-loop.js`:
1. Add `import { toolsForClaude, getTool } from './tool-registry.js';` (already imports `getTool`; add `toolsForClaude` to the same import line).
2. Replace the `handleNewRequest` function body:

```js
  async function handleNewRequest({ userId, dialogId, text }) {
    const facts = memory.loadFacts(userId);
    const factsBlock = facts.length
      ? `Fatos conhecidos sobre este usuário (use para não pedir informação que ele já deu antes):\n${facts.map(f => `- ${f.fact} (${f.howToApply})`).join('\n')}`
      : '';

    const messages = [{ role: 'user', content: text }];

    while (true) {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 1024,
        system: `Você é o assistente do Bitrix24. Interprete o pedido do usuário e use as ferramentas disponíveis para executá-lo. ${factsBlock}`,
        tools: toolsForClaude(),
        messages,
      });

      if (response.stop_reason !== 'tool_use') {
        const textBlock = response.content.find(b => b.type === 'text');
        const replyText = textBlock ? textBlock.text : '(sem resposta)';
        await evaluateMemory({ userId, interactionSummary: `Pedido do usuário: "${text}". Resposta do assistente: "${replyText}".` });
        return { replies: [replyText] };
      }

      const toolUseBlock = response.content.find(b => b.type === 'tool_use');
      const tool = getTool(toolUseBlock.name);

      if (tool.sensitive) {
        const introBlock = response.content.find(b => b.type === 'text');
        const summary = introBlock ? introBlock.text : `Executar ${tool.name} com ${JSON.stringify(toolUseBlock.input)}`;
        pendingActions.setPending(dialogId, { tool: tool.name, params: toolUseBlock.input, summary });
        return { replies: [`${summary} Confirma? (sim/não)`] };
      }

      const result = await executeTool(tool.name, toolUseBlock.input);
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: JSON.stringify(result) }] });
    }
  }
```

3. Update the object literal at the bottom so `_handleNewRequest` still points at the (now fully implemented) `handleNewRequest`:

```js
  const loop = {
    async handleMessage({ userId, dialogId, text }) {
      const pending = pendingActions.getPending(dialogId);
      if (pending) {
        return handlePending({ userId, dialogId, text, pending });
      }
      return loop._handleNewRequest({ userId, dialogId, text });
    },
    _handleNewRequest: handleNewRequest,
  };
```

(This block is unchanged from Task 9 — listed here only to confirm it doesn't need edits.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/bot/agent-loop.test.js`
Expected: `7 passed` (4 from Task 9 + 3 new)

- [ ] **Step 5: Commit**

```bash
git add src/bot/agent-loop.js src/bot/agent-loop.test.js
git commit -m "feat(bot): implement tool-use loop for new requests, with memory extraction"
```

---

### Task 11: `server.js` — HTTP endpoint wiring it all together

**Files:**
- Create: `src/bot/server.js`
- Test: `src/bot/server.test.js`

**Interfaces:**
- Consumes: `createRateLimiter` from `./message-rate-limiter.js`; a `reply` function shaped like `createReplyer(...).reply`; an `agentLoop` object shaped like `createAgentLoop(...)`'s return value.
- Produces: `createApp({ botConfig, agentLoop, reply, rateLimiter }) => express.Application` — an Express app, not yet listening (the actual `app.listen(...)` call and reading `bot-config.json` from disk happens in Task 12's `register.js`-adjacent bootstrap, kept out of this file so it stays testable via `supertest`-style direct request injection without opening a real port).
- `botConfig` shape: `{ botId: number, botToken: string }`. The expected `application_token` is derived, not stored separately: `'custom' + botConfig.botToken` (validated empirically in Task 1).

- [ ] **Step 1: Install a test-only HTTP client helper**

```bash
npm install --save-dev supertest
```

- [ ] **Step 2: Write the failing test**

```js
// src/bot/server.test.js
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from './server.js';

function setup({ handleMessageImpl, allowed = true } = {}) {
  const agentLoop = { handleMessage: vi.fn(handleMessageImpl ?? (async () => ({ replies: ['ok'] }))) };
  const reply = vi.fn().mockResolvedValue();
  const rateLimiter = { checkAndConsume: vi.fn(() => (allowed ? { allowed: true } : { allowed: false, scope: 'user' })) };
  const app = createApp({ botConfig: { botId: 456, botToken: 'secret-token' }, agentLoop, reply, rateLimiter });
  return { app, agentLoop, reply, rateLimiter };
}

function eventBody(overrides = {}) {
  return {
    event: 'ONIMBOTV2MESSAGEADD',
    auth: { application_token: 'customsecret-token' },
    data: {
      chat: { id: 5, dialogId: 'dialog-1' },
      user: { id: 'user-1' },
      message: { id: 1, text: 'oi' },
    },
    ...overrides,
  };
}

describe('POST /bitrix-events', () => {
  it('rejects requests with a missing or wrong application_token with 403', async () => {
    const { app, agentLoop } = setup();
    const res = await request(app).post('/bitrix-events').send(eventBody({ auth: { application_token: 'wrong' } }));
    expect(res.status).toBe(403);
    expect(agentLoop.handleMessage).not.toHaveBeenCalled();
  });

  it('processes a valid ONIMBOTV2MESSAGEADD event and replies with the agent-loop result', async () => {
    const { app, agentLoop, reply } = setup({ handleMessageImpl: async () => ({ replies: ['Olá!'] }) });
    const res = await request(app).post('/bitrix-events').send(eventBody());

    expect(res.status).toBe(200);
    expect(agentLoop.handleMessage).toHaveBeenCalledWith({ userId: 'user-1', dialogId: 'dialog-1', text: 'oi' });
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith('dialog-1', 'Olá!'));
  });

  it('ignores events that are not ONIMBOTV2MESSAGEADD', async () => {
    const { app, agentLoop } = setup();
    const res = await request(app).post('/bitrix-events').send(eventBody({ event: 'ONIMBOTV2JOINCHAT' }));
    expect(res.status).toBe(200);
    expect(agentLoop.handleMessage).not.toHaveBeenCalled();
  });

  it('replies with a rate-limit message instead of calling the agent loop when the limit is exceeded', async () => {
    const { app, agentLoop, reply } = setup({ allowed: false });
    const res = await request(app).post('/bitrix-events').send(eventBody());

    expect(res.status).toBe(200);
    expect(agentLoop.handleMessage).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith('dialog-1', expect.stringMatching(/aguard/i)));
  });

  it('replies with a friendly error and never throws when the agent loop fails', async () => {
    const { app, reply } = setup({ handleMessageImpl: async () => { throw new Error('Claude API timeout'); } });
    const res = await request(app).post('/bitrix-events').send(eventBody());

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith('dialog-1', expect.stringMatching(/não consegui|tenta de novo/i)));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/bot/server.test.js`
Expected: FAIL — `Cannot find module './server.js'`

- [ ] **Step 4: Write the implementation**

```js
// src/bot/server.js
import express from 'express';

export function createApp({ botConfig, agentLoop, reply, rateLimiter }) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  const expectedToken = 'custom' + botConfig.botToken;

  app.post('/bitrix-events', (req, res) => {
    const token = req.body?.auth?.application_token;
    if (token !== expectedToken) {
      return res.status(403).send('forbidden');
    }

    // Ack immediately — Bitrix24 expects a fast response, the actual work happens after.
    res.status(200).send('ok');

    if (req.body.event !== 'ONIMBOTV2MESSAGEADD') return;

    const dialogId = req.body.data?.chat?.dialogId;
    const userId = req.body.data?.user?.id;
    const text = req.body.data?.message?.text;
    if (!dialogId || !userId || !text) return;

    handleEvent({ dialogId, userId, text }).catch(() => {
      // handleEvent already replies to the user on every error path; this catch
      // only guards against reply() itself throwing, which we can't recover from.
    });

    async function handleEvent({ dialogId, userId, text }) {
      const rl = rateLimiter.checkAndConsume(userId);
      if (!rl.allowed) {
        await reply(dialogId, 'Você está enviando mensagens rápido demais, aguarde um instante e tente de novo.');
        return;
      }

      try {
        const { replies } = await agentLoop.handleMessage({ userId, dialogId, text });
        for (const msg of replies) await reply(dialogId, msg);
      } catch (err) {
        await reply(dialogId, 'Não consegui processar sua mensagem agora, tenta de novo em instantes.');
      }
    }
  });

  return app;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/bot/server.test.js`
Expected: `5 passed`

- [ ] **Step 6: Commit**

```bash
git add src/bot/server.js src/bot/server.test.js package.json package-lock.json
git commit -m "feat(bot): add Express endpoint wiring rate limiting, agent loop, and replies"
```

---

### Task 12: `register.js` + `bootstrap.js` — wire real dependencies and start the process

**Files:**
- Create: `src/bot/register.js` (production version of the Task 1 spike)
- Create: `src/bot/bootstrap.js` (reads `bot-config.json`, constructs every real dependency, calls `app.listen`)
- Delete: `src/bot/spike-register.js` (superseded by `register.js`)

**Interfaces:**
- Consumes every module built in Tasks 3–11 (`tool-registry.js`, `message-rate-limiter.js`, `audit-log.js`, `pending-actions.js`, `memory.js`, `reply.js`, `agent-loop.js`, `server.js`), plus `Bitrix24Client` and `resolveWebhook` (already used in Task 1), plus `Anthropic` from `@anthropic-ai/sdk`.
- No test for this task: `bootstrap.js` is a thin composition root (wiring only, no branching logic) and `register.js` hits the real Bitrix24 API — both are validated manually in Step 4/5, consistent with how Task 1 was validated.

- [ ] **Step 1: Write `register.js`** (same two-call flow proven in the Task 1 spike — `imbot.v2.Bot.register` then `imbot.v2.Bot.update` — with the throwaway `_spike` suffix removed from the bot code and a `README`-friendly `console.log`)

```js
// src/bot/register.js
import { writeFileSync } from 'fs';
import { Bitrix24Client } from '../bitrix24/client.js';
import { resolveWebhook } from '../utils/resolve-webhook.js';

const EVENT_HANDLER_URL = process.env.BOT_EVENT_HANDLER_URL;
if (!EVENT_HANDLER_URL) {
  throw new Error('Defina BOT_EVENT_HANDLER_URL (URL pública, https, do endpoint /bitrix-events) antes de rodar este script.');
}

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('Defina BOT_TOKEN (segredo escolhido por você, string até 40 caracteres) antes de rodar este script.');
}

const client = new Bitrix24Client(resolveWebhook());

const registerResult = await client.call('imbot.v2.Bot.register', {
  fields: {
    code: 'assistente_claude',
    botToken: BOT_TOKEN,
    properties: { name: 'Assistente' },
    type: 'bot',
    eventMode: 'fetch',
  },
});
const botId = registerResult.result;

await client.call('imbot.v2.Bot.update', {
  botId,
  botToken: BOT_TOKEN,
  fields: { eventMode: 'webhook', webhookUrl: EVENT_HANDLER_URL },
});

const config = {
  botId,
  botToken: BOT_TOKEN,
  webhookUrl: EVENT_HANDLER_URL,
};

writeFileSync(new URL('./bot-config.json', import.meta.url), JSON.stringify(config, null, 2));
console.log('Bot registrado com sucesso. Config salva em src/bot/bot-config.json:');
console.log(config);
```

- [ ] **Step 2: Write `bootstrap.js`**

```js
// src/bot/bootstrap.js
import { readFileSync } from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { Bitrix24Client } from '../bitrix24/client.js';
import { resolveWebhook } from '../utils/resolve-webhook.js';
import { createApp } from './server.js';
import { createAgentLoop } from './agent-loop.js';
import { createReplyer } from './reply.js';
import { createRateLimiter } from './message-rate-limiter.js';
import { createPendingActionsStore } from './pending-actions.js';
import { createMemoryStore } from './memory.js';
import { createAuditLog } from './audit-log.js';

const PORT = process.env.BOT_PORT || 3300;

const botConfig = JSON.parse(readFileSync(new URL('./bot-config.json', import.meta.url), 'utf-8'));

const bitrixClient = new Bitrix24Client(resolveWebhook());
const anthropic = new Anthropic();

const reply = createReplyer({ client: bitrixClient, botId: botConfig.botId, botToken: botConfig.botToken }).reply;
const rateLimiter = createRateLimiter();
const pendingActions = createPendingActionsStore({ filePath: new URL('./data/pending-actions.json', import.meta.url).pathname });
const memory = createMemoryStore({ dataDir: new URL('./data', import.meta.url).pathname });
const auditLog = createAuditLog(new URL('./data/audit.jsonl', import.meta.url).pathname);
const agentLoop = createAgentLoop({ anthropic, pendingActions, memory, auditLog });

const app = createApp({ botConfig, agentLoop, reply, rateLimiter });

app.listen(PORT, () => {
  console.log(`Bot Server escutando na porta ${PORT}`);
});
```

- [ ] **Step 3: Delete the Task 1 spike script**

```bash
git rm src/bot/spike-register.js
```

- [ ] **Step 4: Run `register.js` against the real portal**

Run: `BOT_EVENT_HANDLER_URL="https://<seu-servidor-publico>/bitrix-events" BOT_TOKEN="<segredo-que-voce-escolher>" node src/bot/register.js`
Expected: prints `Bot registrado com sucesso...` and creates `src/bot/bot-config.json` (gitignored per Task 2, Step 6).

- [ ] **Step 5: Start the Bot Server and send a real message**

Run: `ANTHROPIC_API_KEY=<sua-chave> BOT_PORT=3300 node src/bot/bootstrap.js` (keep running; your infrastructure needs to route `https://<seu-servidor-publico>/bitrix-events` to this process, e.g. via reverse proxy).

In the Bitrix24 portal, open a 1:1 chat with the newly registered "Assistente" bot and send a read request (e.g. "quantos leads eu tenho?"). Confirm a reply arrives. Then send a write request (e.g. "cria uma tarefa de teste pra mim") and confirm the bot asks for confirmation before executing, and that replying "sim" executes it and updates the audit log at `src/bot/data/audit.jsonl`.

- [ ] **Step 6: Commit**

```bash
git add src/bot/register.js src/bot/bootstrap.js
git commit -m "feat(bot): add register.js and bootstrap.js composition root"
```

---

## Self-Review Notes

- **Spec coverage:** every "Componentes" entry (1–7) maps to a task — `register.js`/premise validation → Task 1 & 12; `server.js` → Task 11; `agent-loop.js` → Tasks 9–10; `pending-actions.js` → Task 6; `reply.js` → Task 8; tool reuse → Task 3; `memory.js` → Task 7. "Rate limit em duas camadas" → Task 4, wired into Task 11. "Log de auditoria" → Task 5, wired into Task 9. The 4-branch confirmation flow (confirm/refuse/adjust/new_request) and its entity-based tie-break rule → Task 9. Memory extraction on both writes and reads → Tasks 9 and 10 respectively (`evaluateMemory` called from both `handlePending`'s confirm branch and `handleNewRequest`'s end-turn branch).
- **Known gap carried forward from the spec, intentionally not covered by a task:** per-user OAuth to close the privilege-escalation risk is explicitly out of scope (spec, "Fora de escopo") — no task should be added for it.
- **Type consistency check:** `pendingActions.getPending`/`setPending`/`clearPending` signatures match between Task 6's implementation and Task 9/10's usage (`{ tool, params, summary }` shape). `memory.loadFacts`/`appendFact` signatures match between Task 7 and Task 9/10. `reply(dialogId, message)` signature matches between Task 8 and Task 11. `getTool(name).handler(params)` / `.sensitive` match between Task 3 and Tasks 9–10.
- **Revisão de 2026-07-17:** todo o plano foi atualizado de `imbot.register`/`imbot.message.add`/`app.info` (API antiga, deprecated) para `imbot.v2.Bot.register`/`.update`, `imbot.v2.Chat.Message.send` e validação via `auth.application_token === 'custom' + botToken`, após validação empírica contra o portal real (Task 1). `botConfig` passou a carregar `{ botId, botToken, webhookUrl }` em vez de `{ applicationToken }`; `createReplyer` agora recebe `botToken` além de `botId`; eventos usam nomes/campos `ONIMBOTV2*` (`data.chat.dialogId`, `data.user.id`, `data.message.text`) em vez do formato antigo `data.PARAMS.*`.
