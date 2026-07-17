// PREMISSA CONFIRMADA em 2026-07-17 (correção do veredito anterior, de 2026-07-16).
//
// O teste original só tentou `imbot.register` (API antiga, deprecated), que falha via
// incoming webhook com HTTP 403 ACCESS_DENIED "Client ID not specified" — isso é real,
// mas não significa que uma aplicação REST local (OAuth) seja necessária.
//
// A API atual `imbot.v2.Bot.register` funciona plenamente sobre o B24_DEFAULT_WEBHOOK
// já existente, usando um `botToken` escolhido livremente (string, até 40 caracteres)
// em vez de client_id/client_secret via OAuth. Testado ponta a ponta contra o portal
// real (neo-voip.bitrix24.com.br):
//   1. imbot.v2.Bot.register (eventMode: 'fetch') -> BOT_ID retornado.
//   2. imbot.v2.Bot.update (eventMode: 'webhook', webhookUrl: <URL pública>) -> OK.
//   3. Mensagem real enviada ao bot -> eventos ONIMBOTV2JOINCHAT e ONIMBOTV2MESSAGEADD
//      chegaram no webhookUrl configurado, form-urlencoded.
//   4. imbot.v2.Chat.Message.send (botId + botToken + dialogId) -> resposta do bot
//      entregue no chat com sucesso.
//
// Validação de autenticidade dos eventos: cada evento recebido traz, no nível raiz do
// payload, `auth[application_token]`. Não usar `data[bot][auth][application_token]`
// (é um token OAuth interno do bot, a doc alerta explicitamente contra usá-lo para
// validação). Empiricamente, com botToken = 'spike_token_12345', o valor recebido foi
// `customspike_token_12345` — ou seja, `auth.application_token === 'custom' + botToken`.
// server.js deve validar comparando com esse valor calculado, sem precisar de app.info.
//
// Conclusão: NÃO é necessário instalar uma aplicação REST local (OAuth) no portal.
// O design original (spec + plano) precisa ser atualizado para usar imbot.v2.* no lugar
// de imbot.register/imbot.message.add/app.info, mas a arquitetura geral (webhook único,
// sem OAuth) se mantém válida.
import { Bitrix24Client } from '../bitrix24/client.js';
import { resolveWebhook } from '../utils/resolve-webhook.js';

const EVENT_HANDLER_URL = process.env.BOT_EVENT_HANDLER_URL;
if (!EVENT_HANDLER_URL) {
  throw new Error('Defina BOT_EVENT_HANDLER_URL (URL pública, https, que vai receber os eventos) antes de rodar este spike.');
}

const BOT_TOKEN = process.env.BOT_TOKEN || 'spike_token_12345';

const client = new Bitrix24Client(resolveWebhook());

console.log('1) Registrando bot via imbot.v2.Bot.register...');
const registerResult = await client.call('imbot.v2.Bot.register', {
  fields: {
    code: 'assistente_claude_spike',
    botToken: BOT_TOKEN,
    properties: { name: 'Assistente (spike)' },
    type: 'bot',
    eventMode: 'fetch',
  },
});
const botId = registerResult.result;
console.log('imbot.v2.Bot.register OK, botId =', botId);

console.log('2) Configurando eventMode=webhook via imbot.v2.Bot.update...');
await client.call('imbot.v2.Bot.update', {
  botId,
  botToken: BOT_TOKEN,
  fields: { eventMode: 'webhook', webhookUrl: EVENT_HANDLER_URL },
});
console.log('imbot.v2.Bot.update OK, webhookUrl =', EVENT_HANDLER_URL);

console.log(
  '\nVEREDITO: registro e configuração via webhook funcionam sem OAuth. ' +
  'Envie uma mensagem para o bot e confirme que os eventos chegam em ' + EVENT_HANDLER_URL +
  ' com auth.application_token === "custom" + botToken.'
);
