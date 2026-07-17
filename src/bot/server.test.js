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
