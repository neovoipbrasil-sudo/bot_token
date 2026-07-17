import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createAuditLog } from './audit-log.js';

let dir;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'audit-log-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('audit-log', () => {
  it('appends a JSON line per logged action', () => {
    const log = createAuditLog(path.join(dir, 'audit.jsonl'));
    log.logAction({ userId: 'u1', dialogId: 'd1', tool: 'crm_create', params: { fields: { TITLE: 'x' } }, result: { created_id: 42 } });
    log.logAction({ userId: 'u2', dialogId: 'd2', tool: 'tasks_create', params: {}, result: { created_id: 1 } });

    const entries = log.readAll();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ userId: 'u1', tool: 'crm_create' });
    expect(entries[1]).toMatchObject({ userId: 'u2', tool: 'tasks_create' });
    expect(typeof entries[0].timestamp).toBe('string');
  });

  it('creates the file if it does not exist yet', () => {
    const log = createAuditLog(path.join(dir, 'nested', 'audit.jsonl'));
    log.logAction({ userId: 'u1', dialogId: 'd1', tool: 'crm_list', params: {}, result: {} });
    expect(log.readAll()).toHaveLength(1);
  });
});
