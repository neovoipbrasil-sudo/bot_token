import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

export function createThreadStore({ filePath }) {
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
    getThread(ticketId) {
      const data = load();
      return data[ticketId] ?? null;
    },

    saveThread(ticketId, thread) {
      const data = load();
      data[ticketId] = thread;
      persist(data);
    },
  };
}
