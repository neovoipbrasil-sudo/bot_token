import { describe, it, expect } from 'vitest';
import { TOOLS, toolsForClaude, getTool } from './tool-registry.js';

describe('tool-registry', () => {
  it('exposes exactly the curated set of tools', () => {
    const names = TOOLS.map(t => t.name).sort();
    expect(names).toEqual([
      'calendar_create', 'calendar_list',
      'crm_create', 'crm_delete', 'crm_get', 'crm_list', 'crm_update',
      'tasks_create', 'tasks_list',
    ]);
  });

  it('marks write actions as sensitive and read actions as not sensitive', () => {
    expect(getTool('crm_list').sensitive).toBe(false);
    expect(getTool('crm_get').sensitive).toBe(false);
    expect(getTool('tasks_list').sensitive).toBe(false);
    expect(getTool('calendar_list').sensitive).toBe(false);
    expect(getTool('crm_create').sensitive).toBe(true);
    expect(getTool('crm_update').sensitive).toBe(true);
    expect(getTool('crm_delete').sensitive).toBe(true);
    expect(getTool('tasks_create').sensitive).toBe(true);
    expect(getTool('calendar_create').sensitive).toBe(true);
  });

  it('converts every tool into a valid Claude tool definition', () => {
    const claudeTools = toolsForClaude();
    expect(claudeTools).toHaveLength(TOOLS.length);
    for (const t of claudeTools) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(t.input_schema).toBeTypeOf('object');
      expect(t.input_schema.type).toBe('object');
    }
  });

  it('getTool throws a clear error for an unknown tool name', () => {
    expect(() => getTool('does_not_exist')).toThrow('Unknown tool: does_not_exist');
  });
});
