import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createPendingActionsStore } from './pending-actions.js';

let dir;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'pending-actions-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('pending-actions', () => {
  it('stores and retrieves a pending action by DIALOG_ID', () => {
    const store = createPendingActionsStore({ filePath: path.join(dir, 'pending.json') });
    store.setPending('dialog-1', { tool: 'crm_create', params: { fields: { TITLE: 'x' } }, summary: 'Criar lead X' });
    expect(store.getPending('dialog-1')).toMatchObject({ tool: 'crm_create', summary: 'Criar lead X' });
  });

  it('returns null for a DIALOG_ID with no pending action', () => {
    const store = createPendingActionsStore({ filePath: path.join(dir, 'pending.json') });
    expect(store.getPending('unknown')).toBeNull();
  });

  it('expires a pending action after ttlMs and returns null', () => {
    let currentTime = 1000;
    const store = createPendingActionsStore({ filePath: path.join(dir, 'pending.json'), ttlMs: 1000, now: () => currentTime });
    store.setPending('dialog-1', { tool: 'crm_create', params: {}, summary: 'x' });
    currentTime += 1001;
    expect(store.getPending('dialog-1')).toBeNull();
  });

  it('clearPending removes the entry immediately', () => {
    const store = createPendingActionsStore({ filePath: path.join(dir, 'pending.json') });
    store.setPending('dialog-1', { tool: 'crm_create', params: {}, summary: 'x' });
    store.clearPending('dialog-1');
    expect(store.getPending('dialog-1')).toBeNull();
  });

  it('persists across store instances pointed at the same file', () => {
    const filePath = path.join(dir, 'pending.json');
    const storeA = createPendingActionsStore({ filePath });
    storeA.setPending('dialog-1', { tool: 'crm_create', params: {}, summary: 'x' });

    const storeB = createPendingActionsStore({ filePath });
    expect(storeB.getPending('dialog-1')).toMatchObject({ tool: 'crm_create' });
  });
});
