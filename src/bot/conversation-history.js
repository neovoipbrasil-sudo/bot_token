import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

export function createConversationHistory({ dataDir, maxTurns = 10 }) {
  function filePathFor(dialogId) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(dialogId))) {
      throw new Error(`Invalid dialogId: ${dialogId}`);
    }
    return path.join(dataDir, 'conversation-history', `${dialogId}.json`);
  }

  function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  return {
    loadHistory(dialogId) {
      const filePath = filePathFor(dialogId);
      if (!existsSync(filePath)) return [];
      return JSON.parse(readFileSync(filePath, 'utf-8'));
    },

    appendExchange(dialogId, userText, assistantText) {
      const filePath = filePathFor(dialogId);
      const history = this.loadHistory(dialogId);

      history.push({ role: 'user', content: userText });
      history.push({ role: 'assistant', content: assistantText });
      while (history.length > maxTurns * 2) history.shift();

      ensureDir(filePath);
      writeFileSync(filePath, JSON.stringify(history, null, 2), 'utf-8');
    },
  };
}
