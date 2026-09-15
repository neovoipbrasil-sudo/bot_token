import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

export function createAuditLog(filePath) {
  function ensureDir() {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  return {
    logAction({ userId, dialogId, tool, params, result, error, timestamp = new Date().toISOString() }) {
      ensureDir();
      const entry = { userId, dialogId, tool, params, result, timestamp };
      if (error !== undefined) entry.error = error;
      appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
    },
    readAll() {
      if (!existsSync(filePath)) return [];
      return readFileSync(filePath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
    },
  };
}
