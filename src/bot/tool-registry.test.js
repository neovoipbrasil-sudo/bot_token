import { describe, it, expect } from 'vitest';
import { TOOLS, toolsForClaude, getTool } from './tool-registry.js';

describe('tool-registry', () => {
  it('exposes exactly the curated set of tools', () => {
    const names = TOOLS.map(t => t.name).sort();
    expect(names).toEqual([
      'bizproc_list', 'bizproc_start',
      'calendar_create', 'calendar_list',
      'chat_send',
      'crm_create', 'crm_delete', 'crm_get', 'crm_list', 'crm_update',
      'departments_list',
      'disk_file_get', 'disk_file_upload', 'disk_folder_list', 'disk_storages',
      'feed_post',
      'groups_list',
      'notify_send',
      'products_create', 'products_get', 'products_list', 'products_sections', 'products_update',
      'read_custom_fields', 'read_pipelines',
      'tasks_create', 'tasks_list',
      'telephony_calls',
      'users_list',
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

    expect(getTool('users_list').sensitive).toBe(false);
    expect(getTool('departments_list').sensitive).toBe(false);
    expect(getTool('disk_storages').sensitive).toBe(false);
    expect(getTool('disk_folder_list').sensitive).toBe(false);
    expect(getTool('disk_file_get').sensitive).toBe(false);
    expect(getTool('disk_file_upload').sensitive).toBe(true);
    expect(getTool('groups_list').sensitive).toBe(false);
    expect(getTool('bizproc_list').sensitive).toBe(false);
    expect(getTool('telephony_calls').sensitive).toBe(false);
    expect(getTool('feed_post').sensitive).toBe(true);
    expect(getTool('notify_send').sensitive).toBe(true);
    expect(getTool('chat_send').sensitive).toBe(true);
    expect(getTool('bizproc_start').sensitive).toBe(true);
    expect(getTool('products_list').sensitive).toBe(false);
    expect(getTool('products_get').sensitive).toBe(false);
    expect(getTool('products_sections').sensitive).toBe(false);
    expect(getTool('products_create').sensitive).toBe(true);
    expect(getTool('products_update').sensitive).toBe(true);
    expect(getTool('read_pipelines').sensitive).toBe(false);
    expect(getTool('read_custom_fields').sensitive).toBe(false);
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
