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
