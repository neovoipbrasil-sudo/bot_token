import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createPendingStore } from './pending-store.js';

let dir;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'pending-store-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('pending-store', () => {
  it('returns no lines and no ticketId for a phone with nothing pending', () => {
    const store = createPendingStore({ filePath: path.join(dir, 'pending.json') });
    expect(store.takePending('5511999999999')).toEqual({ ticketId: null, lines: [] });
  });

  it('accumulates lines appended for the same phone, keeping the most recent ticketId', () => {
    const store = createPendingStore({ filePath: path.join(dir, 'pending.json') });
    store.appendPending('5511999999999', '[03/09 14:31] Cliente: oi', 106389);
    store.appendPending('5511999999999', '[03/09 14:43] Cliente: tudo bem?', 106500);

    expect(store.takePending('5511999999999')).toEqual({
      ticketId: 106500,
      lines: ['[03/09 14:31] Cliente: oi', '[03/09 14:43] Cliente: tudo bem?'],
    });
  });

  it('clears the lines once they are taken, so a second take is empty', () => {
    const store = createPendingStore({ filePath: path.join(dir, 'pending.json') });
    store.appendPending('5511999999999', '[03/09 14:31] Cliente: oi', 106389);

    store.takePending('5511999999999');

    expect(store.takePending('5511999999999')).toEqual({ ticketId: null, lines: [] });
  });

  it('keeps pending lines of different phones separate', () => {
    const store = createPendingStore({ filePath: path.join(dir, 'pending.json') });
    store.appendPending('5511999999999', 'Cliente: oi', 1);
    store.appendPending('5521888888888', 'Cliente: boa tarde', 2);

    expect(store.takePending('5511999999999')).toEqual({ ticketId: 1, lines: ['Cliente: oi'] });
    expect(store.takePending('5521888888888')).toEqual({ ticketId: 2, lines: ['Cliente: boa tarde'] });
  });

  it('persists across store instances pointed at the same file', () => {
    const filePath = path.join(dir, 'pending.json');
    const storeA = createPendingStore({ filePath });
    storeA.appendPending('5511999999999', 'Cliente: oi', 1);

    const storeB = createPendingStore({ filePath });
    expect(storeB.takePending('5511999999999')).toEqual({ ticketId: 1, lines: ['Cliente: oi'] });
  });

  it('lists every phone with something pending', () => {
    const store = createPendingStore({ filePath: path.join(dir, 'pending.json') });
    store.appendPending('5511999999999', 'Cliente: oi', 1);
    store.appendPending('5521888888888', 'Cliente: boa tarde', 2);

    expect(store.listPhones().sort()).toEqual(['5511999999999', '5521888888888']);
  });

  it('reads old records that stored a bare array (pre-ticketId format) as lines with ticketId null', () => {
    const filePath = path.join(dir, 'pending.json');
    writeFileSync(filePath, JSON.stringify({ '5511999999999': ['Cliente: oi', 'Cliente: tudo bem?'] }), 'utf-8');
    const store = createPendingStore({ filePath });

    expect(store.takePending('5511999999999')).toEqual({
      ticketId: null,
      lines: ['Cliente: oi', 'Cliente: tudo bem?'],
    });
  });
});
