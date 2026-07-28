import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createThreadStore } from './thread-store.js';

let dir;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'thread-store-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('thread-store', () => {
  it('returns null for a ticketId with no thread yet', () => {
    const store = createThreadStore({ filePath: path.join(dir, 'threads.json') });
    expect(store.getThread(93660)).toBeNull();
  });

  it('stores and retrieves a thread by ticketId', () => {
    const store = createThreadStore({ filePath: path.join(dir, 'threads.json') });
    store.saveThread(93660, { commentId: 297878, lines: ['Cliente: oi'] });
    expect(store.getThread(93660)).toEqual({ commentId: 297878, lines: ['Cliente: oi'] });
  });

  it('overwrites the thread on a second save for the same ticketId', () => {
    const store = createThreadStore({ filePath: path.join(dir, 'threads.json') });
    store.saveThread(93660, { commentId: 297878, lines: ['Cliente: oi'] });
    store.saveThread(93660, { commentId: 297878, lines: ['Cliente: oi', 'SDR: tudo bem'] });
    expect(store.getThread(93660)).toEqual({ commentId: 297878, lines: ['Cliente: oi', 'SDR: tudo bem'] });
  });

  it('persists across store instances pointed at the same file', () => {
    const filePath = path.join(dir, 'threads.json');
    const storeA = createThreadStore({ filePath });
    storeA.saveThread(93660, { commentId: 297878, lines: ['Cliente: oi'] });

    const storeB = createThreadStore({ filePath });
    expect(storeB.getThread(93660)).toEqual({ commentId: 297878, lines: ['Cliente: oi'] });
  });
});
