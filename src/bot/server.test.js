import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from './server.js';
import { parseMsnTalkEvent } from '../msntalk/webhook-handler.js';

function setup({ handleMessageImpl, allowed = true, bitrixClient = { call: vi.fn().mockResolvedValue({ result: {} }) } } = {}) {
  const agentLoop = { handleMessage: vi.fn(handleMessageImpl ?? (async () => ({ replies: ['ok'] }))) };
  const reply = vi.fn().mockResolvedValue();
  const replyWithFile = vi.fn().mockResolvedValue();
  const rateLimiter = { checkAndConsume: vi.fn(() => (allowed ? { allowed: true } : { allowed: false, scope: 'user' })) };
  const app = createApp({ botConfig: { botId: 456, botToken: 'secret-token' }, agentLoop, reply, replyWithFile, rateLimiter, bitrixClient });
  return { app, agentLoop, reply, replyWithFile, rateLimiter, bitrixClient };
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

  it('sends a file-attachment reply via replyWithFile when a reply item includes a file', async () => {
    const file = { name: 'relatorio.pdf', downloadUrl: 'https://x/download', size: 1024 };
    const { app, replyWithFile } = setup({ handleMessageImpl: async () => ({ replies: [{ message: 'Pronto!', file }] }) });
    const res = await request(app).post('/bitrix-events').send(eventBody());

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(replyWithFile).toHaveBeenCalledWith('dialog-1', 'Pronto!', file));
  });

  it('replies with a friendly error and never throws when the agent loop fails', async () => {
    const { app, reply } = setup({ handleMessageImpl: async () => { throw new Error('Claude API timeout'); } });
    const res = await request(app).post('/bitrix-events').send(eventBody());

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith('dialog-1', expect.stringMatching(/não consegui|tenta de novo/i)));
  });

  it('processes an attachment-only message (no text) instead of silently dropping it', async () => {
    const bitrixClient = { call: vi.fn().mockResolvedValue({ result: { NAME: 'nota.txt', SIZE: 10, DOWNLOAD_URL: 'https://neo-voip.bitrix24.com.br/download/nota.txt' } }) };
    const { app, agentLoop } = setup({ handleMessageImpl: async () => ({ replies: ['Recebi o arquivo!'] }), bitrixClient });
    const res = await request(app).post('/bitrix-events').send(eventBody({
      data: {
        chat: { id: 5, dialogId: 'dialog-1' },
        user: { id: 'user-1' },
        message: { id: 1, text: '', params: { FILE_ID: ['184226'] } },
      },
    }));

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(agentLoop.handleMessage).toHaveBeenCalled());
    expect(bitrixClient.call).toHaveBeenCalledWith('disk.file.get', { id: '184226' });
    const call = agentLoop.handleMessage.mock.calls[0][0];
    expect(call.text).toContain('[Anexo: nota.txt]');
  });
});

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
      msg: { fromMe: false, text: 'oi', timestamp: 1784556288057 },
      ticket: { id: 1, protocol: 'p1', contact: { number: '5511999999999' } },
    };
    const res = await request(app).post('/msntalk-events/right-secret').send(body);

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(syncTimeline).toHaveBeenCalledWith({
      event: parseMsnTalkEvent(body),
      client: expect.anything(),
      auditLog: expect.anything(),
      ticketUrlTemplate: undefined,
      threadStore: undefined,
    }));
  });

  it('responds 200 without calling syncTimeline when the event is unrecognized', async () => {
    const { app, syncTimeline } = await setupMsnTalk();

    const res = await request(app).post('/msntalk-events/right-secret').send({ method: 'ticket_closed' });

    expect(res.status).toBe(200);
    expect(syncTimeline).not.toHaveBeenCalled();
  });

  it('responds 200 and logs an error audit-log entry when syncTimeline rejects', async () => {
    const auditLog = { logAction: vi.fn() };
    const { app } = await setupMsnTalk({
      syncTimelineImpl: async () => { throw new Error('crm.deal.list failed'); },
      auditLog,
    });

    const body = {
      method: 'message',
      msg: { fromMe: false, text: 'oi' },
      ticket: { id: 42, protocol: 'p1', contact: { number: '5511999999999' } },
    };
    const res = await request(app).post('/msntalk-events/right-secret').send(body);

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(auditLog.logAction).toHaveBeenCalledWith({
      tool: 'msntalk-sync',
      params: { phone: '5511999999999', ticketId: 42 },
      result: 'error',
    }));
  });

  it('responds 200 and logs an error audit-log entry instead of crashing when parseMsnTalkEvent throws', async () => {
    vi.doMock('../msntalk/webhook-handler.js', () => ({
      parseMsnTalkEvent: () => { throw new RangeError('Invalid time value'); },
    }));
    const auditLog = { logAction: vi.fn() };
    const { app, syncTimeline } = await setupMsnTalk({ auditLog });

    const body = {
      method: 'message',
      msg: { fromMe: false, text: 'oi', timestamp: 'garbage' },
      ticket: { id: 99, protocol: 'p1', contact: { number: '5511999999999' } },
    };
    const res = await request(app).post('/msntalk-events/right-secret').send(body);

    expect(res.status).toBe(200);
    expect(syncTimeline).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(auditLog.logAction).toHaveBeenCalledWith({
      tool: 'msntalk-sync',
      params: { rawTicketId: 99 },
      result: 'error',
    }));
  });
});
