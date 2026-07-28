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

  it('clears the pending action and surfaces the real error when the tool execution fails', async () => {
    stores._pendingData.set('dialog-1', { tool: 'tasks_create', params: { fields: { TITLE: 'Teste' } }, summary: 'Criar tarefa "Teste"' });

    const anthropic = { messages: { create: vi.fn().mockResolvedValue(claudeJsonResponse({ category: 'confirm', updatedParams: null })) } };
    const apiError = Object.assign(new Error('Request failed with status code 400'), {
      response: { data: { error: 'ERROR_CORE', error_description: 'O responsável não foi especificado.' } },
    });
    const executedTool = vi.fn().mockRejectedValue(apiError);
    const loop = createAgentLoop({ anthropic, ...stores, toolExecutor: executedTool });

    const { replies } = await loop.handleMessage({ userId: 'u1', dialogId: 'dialog-1', text: 'sim' });

    expect(stores.pendingActions.clearPending).toHaveBeenCalledWith('dialog-1');
    expect(stores.auditLog.logAction).toHaveBeenCalledWith(expect.objectContaining({ tool: 'tasks_create', result: 'error' }));
    expect(replies[0]).toContain('O responsável não foi especificado.');
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

  it('defaults RESPONSIBLE_ID to the requesting user when creating a task without one specified', async () => {
    const anthropic = { messages: { create: vi.fn() } };
    anthropic.messages.create.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Vou criar a tarefa "Teste".' },
        { type: 'tool_use', id: 'call_1', name: 'tasks_create', input: { fields: { TITLE: 'Teste' } } },
      ],
    });
    const executedTool = vi.fn();
    const loop = createAgentLoop({ anthropic, ...stores, toolExecutor: executedTool });

    await loop.handleMessage({ userId: 'u1', dialogId: 'dialog-1', text: 'cria uma tarefa de teste' });

    expect(stores.pendingActions.setPending).toHaveBeenCalledWith('dialog-1', expect.objectContaining({
      params: { fields: { TITLE: 'Teste', RESPONSIBLE_ID: 'u1' } },
    }));
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

    const anthropic = { messages: { create: vi.fn() } };
    anthropic.messages.create
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] })
      .mockResolvedValueOnce(claudeJsonResponse({ fact: null }));
    const loop = createAgentLoop({ anthropic, ...stores, toolExecutor: vi.fn() });

    await loop.handleMessage({ userId: 'u1', dialogId: 'dialog-1', text: 'oi' });

    const firstCallArgs = anthropic.messages.create.mock.calls[0][0];
    expect(firstCallArgs.system).toMatch(/Departamento Comercial|departamento Comercial/);
  });

  it('includes prior conversation history from the same dialog in the messages sent to Claude', async () => {
    const conversationHistory = {
      loadHistory: vi.fn(() => [
        { role: 'user', content: 'quantos leads eu tenho?' },
        { role: 'assistant', content: 'Você tem 5 leads.' },
      ]),
      appendExchange: vi.fn(),
    };
    const anthropic = { messages: { create: vi.fn() } };
    anthropic.messages.create
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'São os mesmos 5 de antes.' }] })
      .mockResolvedValueOnce(claudeJsonResponse({ fact: null }));
    const loop = createAgentLoop({ anthropic, ...stores, conversationHistory, toolExecutor: vi.fn() });

    await loop.handleMessage({ userId: 'u1', dialogId: 'dialog-1', text: 'e quantos são desse mês?' });

    const firstCallArgs = anthropic.messages.create.mock.calls[0][0];
    expect(firstCallArgs.messages).toEqual([
      { role: 'user', content: 'quantos leads eu tenho?' },
      { role: 'assistant', content: 'Você tem 5 leads.' },
      { role: 'user', content: 'e quantos são desse mês?' },
    ]);
  });

  it('appends the exchange to conversation history after a final text reply', async () => {
    const conversationHistory = { loadHistory: vi.fn(() => []), appendExchange: vi.fn() };
    const anthropic = { messages: { create: vi.fn() } };
    anthropic.messages.create
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Olá! Como posso ajudar?' }] })
      .mockResolvedValueOnce(claudeJsonResponse({ fact: null }));
    const loop = createAgentLoop({ anthropic, ...stores, conversationHistory, toolExecutor: vi.fn() });

    await loop.handleMessage({ userId: 'u1', dialogId: 'dialog-1', text: 'oi' });

    expect(conversationHistory.appendExchange).toHaveBeenCalledWith('dialog-1', 'oi', 'Olá! Como posso ajudar?');
  });
});
