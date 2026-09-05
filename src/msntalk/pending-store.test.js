import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createPendingStore } from './pending-store.js';

let dir;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'pending-store-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('pending-store', () => {
  it('returns an empty array for a phone with nothing pending', () => {
    const store = createPendingStore({ filePath: path.join(dir, 'pending.json') });
    expect(store.takePending('5511999999999')).toEqual([]);
  });

  it('accumulates lines appended for the same phone', () => {
    const store = createPendingStore({ filePath: path.join(dir, 'pending.json') });
    store.appendPending('5511999999999', '[03/09 14:31] Cliente: oi');
    store.appendPending('5511999999999', '[03/09 14:43] Cliente: tudo bem?');

    expect(store.takePending('5511999999999')).toEqual([
      '[03/09 14:31] Cliente: oi',
      '[03/09 14:43] Cliente: tudo bem?',
    ]);
  });

  it('clears the lines once they are taken, so a second take is empty', () => {
    const store = createPendingStore({ filePath: path.join(dir, 'pending.json') });
    store.appendPending('5511999999999', '[03/09 14:31] Cliente: oi');

    store.takePending('5511999999999');

    expect(store.takePending('5511999999999')).toEqual([]);
  });

  it('keeps pending lines of different phones separate', () => {
    const store = createPendingStore({ filePath: path.join(dir, 'pending.json') });
    store.appendPending('5511999999999', 'Cliente: oi');
    store.appendPending('5521888888888', 'Cliente: boa tarde');

    expect(store.takePending('5511999999999')).toEqual(['Cliente: oi']);
    expect(store.takePending('5521888888888')).toEqual(['Cliente: boa tarde']);
  });

  it('persists across store instances pointed at the same file', () => {
    const filePath = path.join(dir, 'pending.json');
    const storeA = createPendingStore({ filePath });
    storeA.appendPending('5511999999999', 'Cliente: oi');

    const storeB = createPendingStore({ filePath });
    expect(storeB.takePending('5511999999999')).toEqual(['Cliente: oi']);
  });
});
