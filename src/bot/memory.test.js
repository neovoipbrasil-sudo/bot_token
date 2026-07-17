import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createMemoryStore } from './memory.js';

let dir;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'memory-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('memory', () => {
  it('starts empty for a user with no memory yet', () => {
    const store = createMemoryStore({ dataDir: dir });
    expect(store.loadFacts('user-1')).toEqual([]);
  });

  it('appends a fact and loads it back with a timestamp', () => {
    const store = createMemoryStore({ dataDir: dir });
    store.appendFact('user-1', { fact: 'Prefere prazos às sextas', reason: 'disse isso duas vezes', howToApply: 'sugerir sexta como prazo padrão' });
    const facts = store.loadFacts('user-1');
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ fact: 'Prefere prazos às sextas' });
    expect(typeof facts[0].addedAt).toBe('string');
  });

  it('does not duplicate an identical fact for the same user', () => {
    const store = createMemoryStore({ dataDir: dir });
    store.appendFact('user-1', { fact: 'X', reason: 'r', howToApply: 'h' });
    store.appendFact('user-1', { fact: 'X', reason: 'r2', howToApply: 'h2' });
    expect(store.loadFacts('user-1')).toHaveLength(1);
  });

  it('keeps facts of different users separate', () => {
    const store = createMemoryStore({ dataDir: dir });
    store.appendFact('user-1', { fact: 'A', reason: 'r', howToApply: 'h' });
    store.appendFact('user-2', { fact: 'B', reason: 'r', howToApply: 'h' });
    expect(store.loadFacts('user-1')).toHaveLength(1);
    expect(store.loadFacts('user-2')).toHaveLength(1);
    expect(store.loadFacts('user-1')[0].fact).toBe('A');
  });

  it('drops the oldest fact once maxFactsPerUser is exceeded', () => {
    const store = createMemoryStore({ dataDir: dir, maxFactsPerUser: 2 });
    store.appendFact('user-1', { fact: 'first', reason: 'r', howToApply: 'h' });
    store.appendFact('user-1', { fact: 'second', reason: 'r', howToApply: 'h' });
    store.appendFact('user-1', { fact: 'third', reason: 'r', howToApply: 'h' });
    const facts = store.loadFacts('user-1');
    expect(facts).toHaveLength(2);
    expect(facts.map(f => f.fact)).toEqual(['second', 'third']);
  });
});
