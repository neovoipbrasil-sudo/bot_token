import { writeFileSync } from 'fs';
import { Bitrix24Client } from '../bitrix24/client.js';
import { resolveWebhook } from '../utils/resolve-webhook.js';

const EVENT_HANDLER_URL = process.env.BOT_EVENT_HANDLER_URL;
if (!EVENT_HANDLER_URL) {
  throw new Error('Defina BOT_EVENT_HANDLER_URL (URL pública, https, do endpoint /bitrix-events) antes de rodar este script.');
}

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('Defina BOT_TOKEN (segredo escolhido por você, string até 40 caracteres) antes de rodar este script.');
}

const client = new Bitrix24Client(resolveWebhook());

const registerResult = await client.call('imbot.v2.Bot.register', {
  fields: {
    code: 'assistente_claude',
    botToken: BOT_TOKEN,
    properties: { name: 'Assistente' },
    type: 'bot',
    eventMode: 'fetch',
  },
});
const botId = registerResult.result.bot.id;

await client.call('imbot.v2.Bot.update', {
  botId,
  botToken: BOT_TOKEN,
  fields: { eventMode: 'webhook', webhookUrl: EVENT_HANDLER_URL },
});

const config = {
  botId,
  botToken: BOT_TOKEN,
  webhookUrl: EVENT_HANDLER_URL,
};

writeFileSync(new URL('./bot-config.json', import.meta.url), JSON.stringify(config, null, 2), { mode: 0o600 });
console.log('Bot registrado com sucesso. Config salva em src/bot/bot-config.json:');
console.log(config);
