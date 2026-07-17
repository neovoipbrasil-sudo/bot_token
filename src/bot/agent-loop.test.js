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
