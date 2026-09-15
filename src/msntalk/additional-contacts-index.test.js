import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createAdditionalContactsIndex } from './additional-contacts-index.js';

let dir;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'additional-contacts-index-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('additional-contacts-index', () => {
  it('returns an empty array for a contact with no indexed bindings yet', () => {
    const index = createAdditionalContactsIndex({ filePath: path.join(dir, 'index.json') });
    expect(index.getEntities(9062)).toEqual([]);
  });

  it('returns the bindings written by replaceAll', () => {
    const index = createAdditionalContactsIndex({ filePath: path.join(dir, 'index.json') });
    index.replaceAll({ 9062: [{ entity: 'lead', entity_id: 4400 }] });
    expect(index.getEntities(9062)).toEqual([{ entity: 'lead', entity_id: 4400 }]);
  });

  it('drops bindings missing from a later replaceAll instead of merging', () => {
    const index = createAdditionalContactsIndex({ filePath: path.join(dir, 'index.json') });
    index.replaceAll({ 9062: [{ entity: 'lead', entity_id: 4400 }] });
    index.replaceAll({ 111: [{ entity: 'deal', entity_id: 8876 }] });

    expect(index.getEntities(9062)).toEqual([]);
    expect(index.getEntities(111)).toEqual([{ entity: 'deal', entity_id: 8876 }]);
  });

  it('persists across index instances pointed at the same file', () => {
    const filePath = path.join(dir, 'index.json');
    const indexA = createAdditionalContactsIndex({ filePath });
    indexA.replaceAll({ 9062: [{ entity: 'lead', entity_id: 4400 }] });

    const indexB = createAdditionalContactsIndex({ filePath });
    expect(indexB.getEntities(9062)).toEqual([{ entity: 'lead', entity_id: 4400 }]);
  });
});
