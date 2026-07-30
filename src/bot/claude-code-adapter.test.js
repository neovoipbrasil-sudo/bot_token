import { describe, it, expect, vi } from 'vitest';
import { createClaudeCodeAdapter } from './claude-code-adapter.js';

describe('claude-code-adapter', () => {
  it('runs the claude CLI without tools, sending the prompt over stdin, and returns the result as a text block', async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify({ result: '{"fact":null}' }));
    const adapter = createClaudeCodeAdapter({ run });

    const response = await adapter.messages.create({
      system: 'system prompt',
      messages: [{ role: 'user', content: 'interaction summary' }],
    });

    expect(response.content).toEqual([{ type: 'text', text: '{"fact":null}' }]);
    const [args, prompt] = run.mock.calls[0];
    expect(args).toContain('-p');
    expect(args).not.toContain('--json-schema');
    expect(args).toContain('--safe-mode');
    expect(prompt).toContain('interaction summary');
  });

  it('passes a json-schema and tool descriptions when tools are provided, returning a tool_use block', async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify({
      structured_output: { text: null, tool_call: { name: 'crm_list', input: { entityType: 'lead' } } },
    }));
    const adapter = createClaudeCodeAdapter({ run });

    const response = await adapter.messages.create({
      system: 'Você é o assistente do Bitrix24.',
      tools: [{ name: 'crm_list', description: 'Lista registros', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'quantos leads eu tenho?' }],
    });

    expect(response.stop_reason).toBe('tool_use');
    const toolUse = response.content.find(b => b.type === 'tool_use');
    expect(toolUse).toMatchObject({ type: 'tool_use', name: 'crm_list', input: { entityType: 'lead' } });
    expect(typeof toolUse.id).toBe('string');

    const [args, prompt] = run.mock.calls[0];
    expect(args).toContain('--json-schema');
    expect(prompt).toContain('crm_list');
    expect(prompt).toContain('quantos leads eu tenho?');
  });

  it('returns a text-only response with end_turn when the model has no tool call', async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify({
      structured_output: { text: 'Você tem 5 leads.', tool_call: null },
    }));
    const adapter = createClaudeCodeAdapter({ run });

    const response = await adapter.messages.create({
      system: 'sys',
      tools: [{ name: 'crm_list', description: 'd', input_schema: {} }],
      messages: [{ role: 'user', content: 'oi' }],
    });

    expect(response.stop_reason).toBe('end_turn');
    expect(response.content).toEqual([{ type: 'text', text: 'Você tem 5 leads.' }]);
  });

  it('serializes assistant tool_use and user tool_result blocks into the transcript', async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify({
      structured_output: { text: 'pronto', tool_call: null },
    }));
    const adapter = createClaudeCodeAdapter({ run });

    await adapter.messages.create({
      system: 'sys',
      tools: [{ name: 'crm_list', description: 'd', input_schema: {} }],
      messages: [
        { role: 'user', content: 'crie um lead' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'crm_create', input: { title: 'x' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"id":9}' }] },
      ],
    });

    const prompt = run.mock.calls[0][1];
    expect(prompt).toContain('crm_create');
    expect(prompt).toContain('"id":9');
  });

  it('tolerates the outer CLI envelope being wrapped in a markdown code fence', async () => {
    const run = vi.fn().mockResolvedValue('```json\n' + JSON.stringify({ result: '{"fact":null}' }) + '\n```');
    const adapter = createClaudeCodeAdapter({ run });

    const response = await adapter.messages.create({ system: 'sys', messages: [{ role: 'user', content: 'oi' }] });

    expect(response.content).toEqual([{ type: 'text', text: '{"fact":null}' }]);
  });

  it('tolerates envelope.result being wrapped in a markdown code fence when there is no structured_output', async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify({
      result: '```json\n' + JSON.stringify({ text: null, tool_call: { name: 'crm_list', input: {} } }) + '\n```',
    }));
    const adapter = createClaudeCodeAdapter({ run });

    const response = await adapter.messages.create({
      system: 'sys',
      tools: [{ name: 'crm_list', description: 'd', input_schema: {} }],
      messages: [{ role: 'user', content: 'oi' }],
    });

    expect(response.stop_reason).toBe('tool_use');
    expect(response.content[0]).toMatchObject({ name: 'crm_list' });
  });

  it('retries once after an ENOENT (transient CLI self-update) and succeeds', async () => {
    const enoentError = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const run = vi.fn()
      .mockRejectedValueOnce(enoentError)
      .mockResolvedValueOnce(JSON.stringify({ result: 'ok' }));
    const adapter = createClaudeCodeAdapter({ run });

    const response = await adapter.messages.create({
      system: 'sys',
      messages: [{ role: 'user', content: 'oi' }],
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(response.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('does not retry and propagates non-ENOENT errors', async () => {
    const run = vi.fn().mockRejectedValue(new Error('Credit balance is too low'));
    const adapter = createClaudeCodeAdapter({ run });

    await expect(adapter.messages.create({ system: 'sys', messages: [{ role: 'user', content: 'oi' }] }))
      .rejects.toThrow('Credit balance is too low');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
