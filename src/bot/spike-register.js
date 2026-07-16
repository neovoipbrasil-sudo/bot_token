// PREMISSA REFUTADA em 2026-07-16: imbot.register via incoming webhook falha com
// HTTP 403 { error: 'ACCESS_DENIED', error_description: 'Access denied! Client ID not specified' }.
// app.info funciona sobre o webhook (retorna SCOPE, incluindo 'imbot'), mas não retorna
// application_token — esse campo só existe para apps REST locais instaladas via OAuth
// (client_id/client_secret), não para webhooks de entrada.
// Ver "Componentes" §1 e "Tratamento de erros e segurança" na spec de design —
// ambos assumem application_token vindo do webhook, o que não se sustenta.
// Conclusão: registrar o bot exige instalar uma aplicação REST local no portal
// (client_id/client_secret via OAuth), não o B24_DEFAULT_WEBHOOK atual.
// O design precisa ser revisto antes de prosseguir para a Task 2.
import { Bitrix24Client } from '../bitrix24/client.js';
import { resolveWebhook } from '../utils/resolve-webhook.js';

const EVENT_HANDLER_URL = process.env.BOT_EVENT_HANDLER_URL;
if (!EVENT_HANDLER_URL) {
  throw new Error('Defina BOT_EVENT_HANDLER_URL (URL pública, https, que vai receber os eventos) antes de rodar este spike.');
}

const client = new Bitrix24Client(resolveWebhook());

console.log('1) Tentando imbot.register...');
const registerResult = await client.call('imbot.register', {
  CODE: 'assistente_claude_spike',
  TYPE: 'B',
  EVENT_HANDLER: EVENT_HANDLER_URL,
  PROPERTIES: { NAME: 'Assistente (spike)', COLOR: 'AZURE' },
});
console.log('imbot.register OK, BOT_ID =', registerResult.result);

console.log('2) Tentando app.info...');
const appInfo = await client.call('app.info', {});
console.log('app.info OK, application_token =', appInfo.result?.application_token ?? '(campo ausente!)');

console.log('\nVEREDITO: se ambas as chamadas acima retornaram sem erro e application_token não é undefined, a premissa do design está confirmada.');
