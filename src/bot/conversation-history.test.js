import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createConversationHistory } from './conversation-history.js';

describe('conversation-history', () => {
  let dataDir;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'conv-history-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns an empty history for a dialog with no prior exchanges', () => {
    const history = createConversationHistory({ dataDir });
    expect(history.loadHistory('chat1')).toEqual([]);
  });

  it('records a user/assistant exchange and returns it in order', () => {
    const history = createConversationHistory({ dataDir });
    history.appendExchange('chat1', 'quantos leads eu tenho?', 'Você tem 5 leads.');

    expect(history.loadHistory('chat1')).toEqual([
      { role: 'user', content: 'quantos leads eu tenho?' },
      { role: 'assistant', content: 'Você tem 5 leads.' },
    ]);
  });

  it('keeps histories separate per dialogId', () => {
    const history = createConversationHistory({ dataDir });
    history.appendExchange('chat1', 'oi', 'olá!');
    history.appendExchange('chat2', 'quem é você?', 'sou o assistente.');

    expect(history.loadHistory('chat1')).toHaveLength(2);
    expect(history.loadHistory('chat2')).toEqual([
      { role: 'user', content: 'quem é você?' },
      { role: 'assistant', content: 'sou o assistente.' },
    ]);
  });

  it('caps the history at maxTurns exchanges, dropping the oldest first', () => {
    const history = createConversationHistory({ dataDir, maxTurns: 2 });
    history.appendExchange('chat1', 'msg1', 'reply1');
    history.appendExchange('chat1', 'msg2', 'reply2');
    history.appendExchange('chat1', 'msg3', 'reply3');

    expect(history.loadHistory('chat1')).toEqual([
      { role: 'user', content: 'msg2' },
      { role: 'assistant', content: 'reply2' },
      { role: 'user', content: 'msg3' },
      { role: 'assistant', content: 'reply3' },
    ]);
  });

  it('rejects dialogIds with unsafe characters to avoid path traversal', () => {
    const history = createConversationHistory({ dataDir });
    expect(() => history.loadHistory('../../etc/passwd')).toThrow('Invalid dialogId');
  });
});
