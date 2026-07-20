import { readFileSync } from 'fs';

export function loadBotConfig({ filePath }) {
  if (process.env.BOT_ID && process.env.BOT_TOKEN) {
    return { botId: Number(process.env.BOT_ID), botToken: process.env.BOT_TOKEN };
  }
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}
