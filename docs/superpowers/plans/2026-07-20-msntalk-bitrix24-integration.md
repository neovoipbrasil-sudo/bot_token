# Integração MSN Talk ↔ Bitrix24 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cada mensagem trocada numa conversa do MSN Talk (cliente ou SDR), gravar automaticamente um comentário na timeline do Deal (ou Lead, se não houver Deal aberto) correspondente no Bitrix24, identificado pelo telefone do contato.

**Architecture:** Nova rota `POST /msntalk-events/:secret` no servidor Express já existente (`src/bot/server.js`), que reaproveita `Bitrix24Client` e `auditLog` já criados em `bootstrap.js`. Três módulos novos e isolados em `src/msntalk/`: um parser puro (`webhook-handler.js`), um buscador de entidade CRM por telefone (`find-crm-entity.js`), e um orquestrador que monta o comentário e chama `timelineAdd` (`sync-timeline.js`).

**Tech Stack:** Node.js (ESM), Express, Vitest, Supertest, `Bitrix24Client` (axios wrapper existente).

## Global Constraints

- Segurança do webhook: comparar `:secret` da URL contra um valor injetado via parâmetro (`msntalkWebhookSecret`), nunca lendo `process.env` dentro de `server.js` — mesmo padrão já usado pela rota `/bitrix-events` com `botConfig.botToken`.
- Secret ausente ou incorreto → responder `404` genérico (nunca `403`, para não confirmar a existência da rota).
- Requisição válida → responder `200` imediatamente, processar de forma assíncrona (mesmo padrão "ack rápido" de `/bitrix-events`).
- Prioridade de match no Bitrix24: Deal aberto (via Contact **ou** Company) primeiro; se não houver, Lead aberto (`STATUS_SEMANTIC_ID = 'P'`) mais recente; se nada, grava no audit log e encerra sem erro.
- Texto do comentário: `[MSN Talk] Cliente: <texto>` para mensagens do cliente (`direction: 'inbound'`), `[MSN Talk] SDR: <texto>` para mensagens do atendente (`direction: 'outbound'`).
- `method: "message_send_uazapi"` é sempre `direction: 'outbound'`; `method: "message"` usa `msg.fromMe` (`true` → `'outbound'`, `false`/ausente → `'inbound'`).
- Qualquer `method` desconhecido, ou payload sem `ticket.contact.number`, é ignorado (retorna `null`, sem erro).
- Variáveis de ambiente novas: `MSNTALK_WEBHOOK_SECRET` (obrigatória — bootstrap falha ao subir sem ela) e `MSNTALK_TICKET_URL_TEMPLATE` (opcional, placeholder `{ticketId}`, valor confirmado `https://app.msntalk.neovoip.com.br/atendimento?ticketId={ticketId}`).

---

## File Structure

- `src/msntalk/webhook-handler.js` (novo) — `parseMsnTalkEvent(body)`: normaliza o payload bruto do MSN Talk.
- `src/msntalk/webhook-handler.test.js` (novo)
- `src/msntalk/find-crm-entity.js` (novo) — `findCrmEntity(client, phone)`: busca Deal/Lead por telefone.
- `src/msntalk/find-crm-entity.test.js` (novo)
- `src/msntalk/sync-timeline.js` (novo) — `syncTimeline({ event, client, auditLog, ticketUrlTemplate })`: orquestra busca + comentário.
- `src/msntalk/sync-timeline.test.js` (novo)
- `src/bot/server.js` (modificar) — adiciona rota `POST /msntalk-events/:secret`, estende assinatura de `createApp`.
- `src/bot/server.test.js` (modificar) — adiciona `describe('POST /msntalk-events/:secret', ...)`.
- `src/bot/bootstrap.js` (modificar) — lê as novas envs, monta `msntalkWebhookSecret`/`msntalkTicketUrlTemplate`, repassa `bitrixClient`/`auditLog` para `createApp`.
- `.env.example` (modificar) — documenta as novas envs.

---

### Task 1: `webhook-handler.js` — parser do payload do MSN Talk

**Files:**
- Create: `src/msntalk/webhook-handler.js`
- Test: `src/msntalk/webhook-handler.test.js`

**Interfaces:**
- Produces: `parseMsnTalkEvent(body: object): { phone: string, text: string, direction: 'inbound' | 'outbound', ticketId: number, protocol: string } | null`

- [ ] **Step 1: Write the failing tests**

```js
// src/msntalk/webhook-handler.test.js
import { describe, it, expect } from 'vitest';
import { parseMsnTalkEvent } from './webhook-handler.js';

function ticketFixture(overrides = {}) {
  return {
    id: 92315,
    protocol: '2026200710580392315',
    contactId: 90604,
    contact: { id: 90604, number: '556121090177', name: 'Fulano' },
    ...overrides,
  };
}

describe('parseMsnTalkEvent', () => {
  it('normalizes an inbound customer message (method: message, fromMe: false)', () => {
    const event = parseMsnTalkEvent({
      method: 'message',
      msg: { fromMe: false, text: 'Bom dia', body: 'Bom dia', from: '556121090177' },
      ticket: ticketFixture(),
    });

    expect(event).toEqual({
      phone: '556121090177',
      text: 'Bom dia',
      direction: 'inbound',
      ticketId: 92315,
      protocol: '2026200710580392315',
    });
  });

  it('normalizes an outbound agent message sent from the panel (method: message, fromMe: true)', () => {
    const event = parseMsnTalkEvent({
      method: 'message',
      msg: { fromMe: true, text: 'Já te respondo', body: 'Já te respondo' },
      ticket: ticketFixture(),
    });

    expect(event.direction).toBe('outbound');
    expect(event.text).toBe('Já te respondo');
  });

  it('falls back to msg.body when msg.text is missing', () => {
    const event = parseMsnTalkEvent({
      method: 'message',
      msg: { fromMe: false, body: 'só tem body' },
      ticket: ticketFixture(),
    });

    expect(event.text).toBe('só tem body');
  });

  it('normalizes an outbound reply sent via message_send_uazapi as always outbound', () => {
    const event = parseMsnTalkEvent({
      method: 'message_send_uazapi',
      msg: { message: '*Gabriel*: Queria confirmar...' },
      ticket: ticketFixture(),
    });

    expect(event).toEqual({
      phone: '556121090177',
      text: '*Gabriel*: Queria confirmar...',
      direction: 'outbound',
      ticketId: 92315,
      protocol: '2026200710580392315',
    });
  });

  it('returns null for an unknown method', () => {
    const event = parseMsnTalkEvent({
      method: 'ticket_closed',
      ticket: ticketFixture(),
    });

    expect(event).toBeNull();
  });

  it('returns null when ticket.contact.number is missing', () => {
    const event = parseMsnTalkEvent({
      method: 'message',
      msg: { fromMe: false, text: 'oi' },
      ticket: { id: 1, protocol: 'x', contact: null },
    });

    expect(event).toBeNull();
  });

  it('returns null when the message text is empty', () => {
    const event = parseMsnTalkEvent({
      method: 'message',
      msg: { fromMe: false },
      ticket: ticketFixture(),
    });

    expect(event).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/msntalk/webhook-handler.test.js`
Expected: FAIL — `Cannot find module './webhook-handler.js'` (arquivo ainda não existe).

- [ ] **Step 3: Write the implementation**

```js
// src/msntalk/webhook-handler.js
export function parseMsnTalkEvent(body) {
  const ticket = body?.ticket;
  const phone = ticket?.contact?.number;
  if (!phone) return null;

  const ticketId = ticket.id;
  const protocol = ticket.protocol;

  if (body.method === 'message') {
    const text = body.msg?.text ?? body.msg?.body;
    if (!text) return null;
    return {
      phone,
      text,
      direction: body.msg?.fromMe === true ? 'outbound' : 'inbound',
      ticketId,
      protocol,
    };
  }

  if (body.method === 'message_send_uazapi') {
    const text = body.msg?.message;
    if (!text) return null;
    return { phone, text, direction: 'outbound', ticketId, protocol };
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/msntalk/webhook-handler.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/msntalk/webhook-handler.js src/msntalk/webhook-handler.test.js
git commit -m "feat(msntalk): add MSN Talk webhook payload parser"
```

---

### Task 2: `find-crm-entity.js` — busca Deal/Lead por telefone

**Files:**
- Create: `src/msntalk/find-crm-entity.js`
- Test: `src/msntalk/find-crm-entity.test.js`

**Interfaces:**
- Consumes: um `client` com `client.call(method: string, params: object): Promise<{ result: any }>` — mesmo shape de `Bitrix24Client.call` (`src/bitrix24/client.js:20`).
- Produces: `findCrmEntity(client, phone: string): Promise<{ entity: 'deal' | 'lead', entity_id: string | number } | null>`

- [ ] **Step 1: Write the failing tests**

```js
// src/msntalk/find-crm-entity.test.js
import { describe, it, expect, vi } from 'vitest';
import { findCrmEntity } from './find-crm-entity.js';

function makeClient(responses) {
  return { call: vi.fn((method) => Promise.resolve(responses[method] ?? { result: [] })) };
}

describe('findCrmEntity', () => {
  it('returns the most recent open deal found via CONTACT_ID', async () => {
    const client = makeClient({
      'crm.duplicate.findbycomm': { result: { CONTACT: [10], LEAD: [] } },
      'crm.deal.list': { result: [{ ID: 555 }] },
    });

    const found = await findCrmEntity(client, '556121090177');

    expect(found).toEqual({ entity: 'deal', entity_id: 555 });
    expect(client.call).toHaveBeenCalledWith('crm.duplicate.findbycomm', { type: 'PHONE', values: ['556121090177'] });
    expect(client.call).toHaveBeenCalledWith('crm.deal.list', {
      filter: { CLOSED: 'N', CONTACT_ID: [10] },
      order: { DATE_CREATE: 'DESC' },
      select: ['ID'],
    });
  });

  it('returns an open deal found via COMPANY_ID when there is no matching contact', async () => {
    const client = makeClient({
      'crm.duplicate.findbycomm': { result: { COMPANY: [20], LEAD: [] } },
      'crm.deal.list': { result: [{ ID: 777 }] },
    });

    const found = await findCrmEntity(client, '556121090177');

    expect(found).toEqual({ entity: 'deal', entity_id: 777 });
    expect(client.call).toHaveBeenCalledWith('crm.deal.list', {
      filter: { CLOSED: 'N', COMPANY_ID: [20] },
      order: { DATE_CREATE: 'DESC' },
      select: ['ID'],
    });
  });

  it('combines CONTACT_ID and COMPANY_ID with OR logic when both match', async () => {
    const client = makeClient({
      'crm.duplicate.findbycomm': { result: { CONTACT: [10], COMPANY: [20], LEAD: [] } },
      'crm.deal.list': { result: [{ ID: 999 }] },
    });

    await findCrmEntity(client, '556121090177');

    expect(client.call).toHaveBeenCalledWith('crm.deal.list', {
      filter: { CLOSED: 'N', LOGIC: 'OR', 0: { CONTACT_ID: [10] }, 1: { COMPANY_ID: [20] } },
      order: { DATE_CREATE: 'DESC' },
      select: ['ID'],
    });
  });

  it('falls back to the most recent open lead when no deal is found', async () => {
    const client = makeClient({
      'crm.duplicate.findbycomm': { result: { CONTACT: [], LEAD: [30] } },
      'crm.lead.list': { result: [{ ID: 111 }] },
    });

    const found = await findCrmEntity(client, '556121090177');

    expect(found).toEqual({ entity: 'lead', entity_id: 111 });
    expect(client.call).toHaveBeenCalledWith('crm.lead.list', {
      filter: { ID: [30], STATUS_SEMANTIC_ID: 'P' },
      order: { DATE_CREATE: 'DESC' },
      select: ['ID'],
    });
  });

  it('returns null when nothing matches the phone at all', async () => {
    const client = makeClient({
      'crm.duplicate.findbycomm': { result: {} },
    });

    const found = await findCrmEntity(client, '556121090177');

    expect(found).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/msntalk/find-crm-entity.test.js`
Expected: FAIL — `Cannot find module './find-crm-entity.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/msntalk/find-crm-entity.js
export async function findCrmEntity(client, phone) {
  const dupRes = await client.call('crm.duplicate.findbycomm', { type: 'PHONE', values: [phone] });
  const matches = dupRes.result ?? {};
  const contactIds = matches.CONTACT ?? [];
  const companyIds = matches.COMPANY ?? [];
  const leadIds = matches.LEAD ?? [];

  if (contactIds.length > 0 || companyIds.length > 0) {
    const filter = { CLOSED: 'N' };
    if (contactIds.length > 0 && companyIds.length > 0) {
      filter.LOGIC = 'OR';
      filter[0] = { CONTACT_ID: contactIds };
      filter[1] = { COMPANY_ID: companyIds };
    } else if (contactIds.length > 0) {
      filter.CONTACT_ID = contactIds;
    } else {
      filter.COMPANY_ID = companyIds;
    }

    const dealRes = await client.call('crm.deal.list', {
      filter,
      order: { DATE_CREATE: 'DESC' },
      select: ['ID'],
    });
    const deals = dealRes.result ?? [];
    if (deals.length > 0) {
      return { entity: 'deal', entity_id: deals[0].ID };
    }
  }

  if (leadIds.length > 0) {
    const leadRes = await client.call('crm.lead.list', {
      filter: { ID: leadIds, STATUS_SEMANTIC_ID: 'P' },
      order: { DATE_CREATE: 'DESC' },
      select: ['ID'],
    });
    const leads = leadRes.result ?? [];
    if (leads.length > 0) {
      return { entity: 'lead', entity_id: leads[0].ID };
    }
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/msntalk/find-crm-entity.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/msntalk/find-crm-entity.js src/msntalk/find-crm-entity.test.js
git commit -m "feat(msntalk): find open Deal or Lead in Bitrix24 by phone number"
```

---

### Task 3: `sync-timeline.js` — orquestra busca + comentário na timeline

**Files:**
- Create: `src/msntalk/sync-timeline.js`
- Test: `src/msntalk/sync-timeline.test.js`

**Interfaces:**
- Consumes:
  - `findCrmEntity(client, phone)` de `./find-crm-entity.js` (Task 2)
  - `timelineAdd({ entity, entity_id, comment, webhook_url })` de `../tools/crm.js:152` (já existe no repo)
  - Um `auditLog` com `auditLog.logAction({ userId?, dialogId?, tool, params, result, timestamp? })` (`src/bot/audit-log.js:11`)
- Produces: `syncTimeline({ event, client, auditLog, ticketUrlTemplate }): Promise<{ matched: boolean, entity?: string, entity_id?: string|number }>` onde `event` é o shape retornado por `parseMsnTalkEvent` (Task 1).

Este módulo importa `timelineAdd` de verdade (não é injetado via parâmetro), então os testes usam `vi.mock` para substituí-lo.

- [ ] **Step 1: Write the failing tests**

```js
// src/msntalk/sync-timeline.test.js
import { describe, it, expect, vi } from 'vitest';

const findCrmEntityMock = vi.fn();
const timelineAddMock = vi.fn().mockResolvedValue({ success: true });

vi.mock('./find-crm-entity.js', () => ({ findCrmEntity: findCrmEntityMock }));
vi.mock('../tools/crm.js', () => ({ timelineAdd: timelineAddMock }));

const { syncTimeline } = await import('./sync-timeline.js');

function baseEvent(overrides = {}) {
  return {
    phone: '556121090177',
    text: 'Bom dia',
    direction: 'inbound',
    ticketId: 92315,
    protocol: '2026200710580392315',
    ...overrides,
  };
}

describe('syncTimeline', () => {
  it('adds a timeline comment prefixed with "Cliente" for inbound messages', async () => {
    findCrmEntityMock.mockResolvedValueOnce({ entity: 'deal', entity_id: 555 });
    const client = {};
    const auditLog = { logAction: vi.fn() };

    const result = await syncTimeline({ event: baseEvent(), client, auditLog });

    expect(result).toEqual({ matched: true, entity: 'deal', entity_id: 555 });
    expect(timelineAddMock).toHaveBeenCalledWith({
      entity: 'deal',
      entity_id: 555,
      comment: '[MSN Talk] Cliente: Bom dia',
    });
    expect(auditLog.logAction).not.toHaveBeenCalled();
  });

  it('adds a timeline comment prefixed with "SDR" for outbound messages', async () => {
    findCrmEntityMock.mockResolvedValueOnce({ entity: 'lead', entity_id: 111 });
    const client = {};
    const auditLog = { logAction: vi.fn() };

    await syncTimeline({ event: baseEvent({ direction: 'outbound', text: 'Já te respondo' }), client, auditLog });

    expect(timelineAddMock).toHaveBeenCalledWith({
      entity: 'lead',
      entity_id: 111,
      comment: '[MSN Talk] SDR: Já te respondo',
    });
  });

  it('appends the resolved ticket link when a template is provided', async () => {
    findCrmEntityMock.mockResolvedValueOnce({ entity: 'deal', entity_id: 555 });
    const client = {};
    const auditLog = { logAction: vi.fn() };

    await syncTimeline({
      event: baseEvent(),
      client,
      auditLog,
      ticketUrlTemplate: 'https://app.msntalk.neovoip.com.br/atendimento?ticketId={ticketId}',
    });

    expect(timelineAddMock).toHaveBeenCalledWith({
      entity: 'deal',
      entity_id: 555,
      comment: '[MSN Talk] Cliente: Bom dia\nhttps://app.msntalk.neovoip.com.br/atendimento?ticketId=92315',
    });
  });

  it('logs to the audit log and skips timelineAdd when no CRM entity matches', async () => {
    findCrmEntityMock.mockResolvedValueOnce(null);
    const client = {};
    const auditLog = { logAction: vi.fn() };

    const result = await syncTimeline({ event: baseEvent(), client, auditLog });

    expect(result).toEqual({ matched: false });
    expect(timelineAddMock).not.toHaveBeenCalled();
    expect(auditLog.logAction).toHaveBeenCalledWith({
      tool: 'msntalk-sync',
      params: { phone: '556121090177', ticketId: 92315 },
      result: 'no-match',
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/msntalk/sync-timeline.test.js`
Expected: FAIL — `Cannot find module './sync-timeline.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/msntalk/sync-timeline.js
import { timelineAdd } from '../tools/crm.js';
import { findCrmEntity } from './find-crm-entity.js';

const DIRECTION_LABEL = { inbound: 'Cliente', outbound: 'SDR' };

export async function syncTimeline({ event, client, auditLog, ticketUrlTemplate }) {
  const found = await findCrmEntity(client, event.phone);

  if (!found) {
    auditLog.logAction({
      tool: 'msntalk-sync',
      params: { phone: event.phone, ticketId: event.ticketId },
      result: 'no-match',
    });
    return { matched: false };
  }

  let comment = `[MSN Talk] ${DIRECTION_LABEL[event.direction]}: ${event.text}`;
  if (ticketUrlTemplate) {
    comment += `\n${ticketUrlTemplate.replace('{ticketId}', event.ticketId)}`;
  }

  await timelineAdd({ entity: found.entity, entity_id: found.entity_id, comment });
  return { matched: true, entity: found.entity, entity_id: found.entity_id };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/msntalk/sync-timeline.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/msntalk/sync-timeline.js src/msntalk/sync-timeline.test.js
git commit -m "feat(msntalk): sync MSN Talk messages to the matched CRM entity's timeline"
```

---

### Task 4: rota `POST /msntalk-events/:secret` em `src/bot/server.js`

**Files:**
- Modify: `src/bot/server.js`
- Test: `src/bot/server.test.js`

**Interfaces:**
- Consumes: `parseMsnTalkEvent` (Task 1), `syncTimeline` (Task 3).
- Produces: `createApp` passa a aceitar também `{ bitrixClient, auditLog, msntalkWebhookSecret, msntalkTicketUrlTemplate }` (além dos parâmetros já existentes `botConfig, agentLoop, reply, rateLimiter`).

- [ ] **Step 1: Write the failing tests**

Adicionar ao final de `src/bot/server.test.js` (não remover os testes existentes de `/bitrix-events`):

```js
// adicionar aos imports do topo do arquivo:
import { parseMsnTalkEvent } from '../msntalk/webhook-handler.js';

// ... (mantém setup() e eventBody() existentes, adiciona um novo describe ao final do arquivo)

async function setupMsnTalk({ syncTimelineImpl, ...overrides } = {}) {
  const syncTimeline = vi.fn(syncTimelineImpl ?? (async () => ({ matched: true })));
  vi.doMock('../msntalk/sync-timeline.js', () => ({ syncTimeline }));
  vi.resetModules();
  const { createApp: createAppFresh } = await import('./server.js');

  const app = createAppFresh({
    botConfig: { botId: 456, botToken: 'secret-token' },
    agentLoop: { handleMessage: vi.fn() },
    reply: vi.fn(),
    rateLimiter: { checkAndConsume: vi.fn() },
    bitrixClient: { call: vi.fn() },
    auditLog: { logAction: vi.fn() },
    msntalkWebhookSecret: 'right-secret',
    msntalkTicketUrlTemplate: undefined,
    ...overrides,
  });

  return { app, syncTimeline };
}

describe('POST /msntalk-events/:secret', () => {
  it('responds 404 for a wrong secret and does not process the event', async () => {
    const { app, syncTimeline } = await setupMsnTalk();

    const res = await request(app).post('/msntalk-events/wrong-secret').send({ method: 'message' });

    expect(res.status).toBe(404);
    expect(syncTimeline).not.toHaveBeenCalled();
  });

  it('responds 200 and calls syncTimeline for a valid event with the right secret', async () => {
    const { app, syncTimeline } = await setupMsnTalk();

    const body = {
      method: 'message',
      msg: { fromMe: false, text: 'oi' },
      ticket: { id: 1, protocol: 'p1', contact: { number: '5511999999999' } },
    };
    const res = await request(app).post('/msntalk-events/right-secret').send(body);

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(syncTimeline).toHaveBeenCalledWith({
      event: parseMsnTalkEvent(body),
      client: expect.anything(),
      auditLog: expect.anything(),
      ticketUrlTemplate: undefined,
    }));
  });

  it('responds 200 without calling syncTimeline when the event is unrecognized', async () => {
    const { app, syncTimeline } = await setupMsnTalk();

    const res = await request(app).post('/msntalk-events/right-secret').send({ method: 'ticket_closed' });

    expect(res.status).toBe(200);
    expect(syncTimeline).not.toHaveBeenCalled();
  });
});
```

> Nota para quem for implementar: como `server.js` importa `syncTimeline` no topo do módulo, o mock precisa ser registrado (`vi.doMock` + `vi.resetModules` + `import()` dinâmico) **antes** de `createApp` ser importado/chamado — por isso `setupMsnTalk()` reimporta `./server.js` dinamicamente depois do mock, em vez de usar o `createApp` importado estaticamente no topo do arquivo. Todos os três testes passam pelo mesmo helper para evitar o erro de tentar fazer asserção de mock (`.not.toHaveBeenCalled()`) sobre o `syncTimeline` real.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/bot/server.test.js`
Expected: FAIL — a rota `/msntalk-events/:secret` ainda não existe, então o Express responde `404` genérico para qualquer request nesse path. O teste de "wrong secret" passa por acidente (já espera 404), mas os dois testes que esperam `res.status === 200` e `syncTimeline` sendo chamado devem falhar.

- [ ] **Step 3: Write the implementation**

```js
// src/bot/server.js
import express from 'express';
import { parseMsnTalkEvent } from '../msntalk/webhook-handler.js';
import { syncTimeline } from '../msntalk/sync-timeline.js';

export function createApp({
  botConfig,
  agentLoop,
  reply,
  rateLimiter,
  bitrixClient,
  auditLog,
  msntalkWebhookSecret,
  msntalkTicketUrlTemplate,
}) {
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

  app.post('/msntalk-events/:secret', (req, res) => {
    if (req.params.secret !== msntalkWebhookSecret) {
      return res.status(404).send('not found');
    }

    // Ack immediately — same "fast ack, process after" pattern as /bitrix-events.
    res.status(200).send('ok');

    const event = parseMsnTalkEvent(req.body);
    if (!event) return;

    syncTimeline({
      event,
      client: bitrixClient,
      auditLog,
      ticketUrlTemplate: msntalkTicketUrlTemplate,
    }).catch(() => {
      // MSN Talk has no retry mechanism we can hook into — failures stay
      // visible via the audit log entry (or its absence) and Bitrix24 errors.
    });
  });

  return app;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/bot/server.test.js`
Expected: PASS (todos os testes de `/bitrix-events` continuam passando, mais os 3 novos de `/msntalk-events/:secret`)

- [ ] **Step 5: Commit**

```bash
git add src/bot/server.js src/bot/server.test.js
git commit -m "feat(bot): add POST /msntalk-events/:secret route wired to sync-timeline"
```

---

### Task 5: wiring em `bootstrap.js` e documentação em `.env.example`

**Files:**
- Modify: `src/bot/bootstrap.js`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `createApp` com a assinatura estendida da Task 4.

Este task é só wiring imperativo (mesmo padrão de `bootstrap.js` hoje, que não tem teste automatizado — é verificado manualmente subindo o processo). Não há teste automatizado novo aqui.

- [ ] **Step 1: Atualizar `src/bot/bootstrap.js`**

Arquivo completo depois da mudança:

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

const msntalkWebhookSecret = process.env.MSNTALK_WEBHOOK_SECRET;
if (!msntalkWebhookSecret) {
  throw new Error(
    'Defina MSNTALK_WEBHOOK_SECRET (segredo usado no path do webhook do MSN Talk, ' +
    'ex.: https://<host>/msntalk-events/<MSNTALK_WEBHOOK_SECRET>) antes de subir o bot.'
  );
}
const msntalkTicketUrlTemplate = process.env.MSNTALK_TICKET_URL_TEMPLATE;

const app = createApp({
  botConfig,
  agentLoop,
  reply,
  rateLimiter,
  bitrixClient,
  auditLog,
  msntalkWebhookSecret,
  msntalkTicketUrlTemplate,
});

app.listen(PORT, () => {
  console.log(`Bot Server escutando na porta ${PORT}`);
});
```

- [ ] **Step 2: Atualizar `.env.example`**

Adicionar ao final do arquivo (mantendo o conteúdo existente sobre `B24_DEFAULT_WEBHOOK`):

```bash
# MSN Talk -> Bitrix24 (sincroniza mensagens do MSN Talk na timeline do Deal/Lead)
# Segredo aleatório usado no path do webhook — configure no painel do MSN Talk como:
#   https://<host>/msntalk-events/<MSNTALK_WEBHOOK_SECRET>
# Gere um valor com: node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
MSNTALK_WEBHOOK_SECRET=

# (Opcional) Template de deep link para abrir o ticket específico no painel do MSN Talk.
# Valor confirmado:
MSNTALK_TICKET_URL_TEMPLATE=https://app.msntalk.neovoip.com.br/atendimento?ticketId={ticketId}
```

- [ ] **Step 3: Rodar a suíte inteira para garantir que nada quebrou**

Run: `npm test`
Expected: PASS (todos os testes existentes + os novos de `src/msntalk/*` e `src/bot/server.test.js`)

- [ ] **Step 4: Commit**

```bash
git add src/bot/bootstrap.js .env.example
git commit -m "feat(bot): wire MSNTALK_WEBHOOK_SECRET / MSNTALK_TICKET_URL_TEMPLATE into bootstrap"
```

---

## Verificação manual pós-implementação (fora do escopo dos testes automatizados)

1. Rodar `node src/bot/bootstrap.js` localmente com `MSNTALK_WEBHOOK_SECRET` definido e um túnel público (ex.: `ngrok`) apontando para a porta do bot.
2. Configurar `https://<túnel>/msntalk-events/<MSNTALK_WEBHOOK_SECRET>` como webhook no painel do MSN Talk.
3. Enviar uma mensagem de teste numa conversa cujo contato tenha telefone cadastrado em um Deal ou Lead aberto no Bitrix24, e conferir que o comentário aparece na timeline.
4. Repetir com um telefone sem nenhum registro correspondente e conferir que a linha aparece em `src/bot/data/audit.jsonl` com `result: 'no-match'`, sem erro no processo.
