import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

export function createMemoryStore({ dataDir, maxFactsPerUser = 50 }) {
  function filePathFor(userId) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(userId))) {
      throw new Error(`Invalid userId: ${userId}`);
    }
    return path.join(dataDir, 'memory', `${userId}.json`);
  }

  function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  return {
    loadFacts(userId) {
      const filePath = filePathFor(userId);
      if (!existsSync(filePath)) return [];
      return JSON.parse(readFileSync(filePath, 'utf-8'));
    },

    appendFact(userId, { fact, reason, howToApply }) {
      const filePath = filePathFor(userId);
      const facts = this.loadFacts(userId);

      if (facts.some(f => f.fact === fact)) return;

      facts.push({ fact, reason, howToApply, addedAt: new Date().toISOString() });
      while (facts.length > maxFactsPerUser) facts.shift();

      ensureDir(filePath);
      writeFileSync(filePath, JSON.stringify(facts, null, 2), 'utf-8');
    },
  };
}
