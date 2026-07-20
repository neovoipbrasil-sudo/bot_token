import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { loadBotConfig } from './bot-config.js';

const ORIGINAL_ENV = { ...process.env };
let dir;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bot-config-test-'));
  delete process.env.BOT_ID;
  delete process.env.BOT_TOKEN;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

describe('loadBotConfig', () => {
  it('uses BOT_ID/BOT_TOKEN from env vars when both are present, ignoring the file path', () => {
    process.env.BOT_ID = '456';
    process.env.BOT_TOKEN = 'secret-from-env';

    const config = loadBotConfig({ filePath: path.join(dir, 'does-not-exist.json') });

    expect(config).toEqual({ botId: 456, botToken: 'secret-from-env' });
  });

  it('falls back to reading the file when env vars are absent', () => {
    const filePath = path.join(dir, 'bot-config.json');
    writeFileSync(filePath, JSON.stringify({ botId: 789, botToken: 'secret-from-file' }));

    const config = loadBotConfig({ filePath });

    expect(config).toEqual({ botId: 789, botToken: 'secret-from-file' });
  });

  it('falls back to the file when only one of the two env vars is set', () => {
    process.env.BOT_ID = '456';
    const filePath = path.join(dir, 'bot-config.json');
    writeFileSync(filePath, JSON.stringify({ botId: 789, botToken: 'secret-from-file' }));

    const config = loadBotConfig({ filePath });

    expect(config).toEqual({ botId: 789, botToken: 'secret-from-file' });
  });

  it('propagates the readFileSync error when neither env vars nor the file exist', () => {
    const filePath = path.join(dir, 'does-not-exist.json');

    expect(() => loadBotConfig({ filePath })).toThrow(/ENOENT/);
  });
});
