import Anthropic from '@anthropic-ai/sdk';
import { Bitrix24Client } from '../bitrix24/client.js';
import { resolveWebhook } from '../utils/resolve-webhook.js';
import { createApp } from './server.js';
import { createAgentLoop } from './agent-loop.js';
import { createClaudeCodeAdapter } from './claude-code-adapter.js';
import { createReplyer } from './reply.js';
import { createRateLimiter } from './message-rate-limiter.js';
import { createPendingActionsStore } from './pending-actions.js';
import { createMemoryStore } from './memory.js';
import { createConversationHistory } from './conversation-history.js';
import { createAuditLog } from './audit-log.js';
import { loadBotConfig } from './bot-config.js';
import { createThreadStore } from '../msntalk/thread-store.js';
import { createPendingStore } from '../msntalk/pending-store.js';
import { createAdditionalContactsIndex } from '../msntalk/additional-contacts-index.js';
import { refreshAdditionalContacts } from '../msntalk/refresh-additional-contacts.js';
import { reconcilePending } from '../msntalk/reconcile-pending.js';

const PORT = process.env.BOT_PORT || 3300;

const botConfig = loadBotConfig({ filePath: new URL('./bot-config.json', import.meta.url) });

const bitrixClient = new Bitrix24Client(resolveWebhook());
const anthropic = process.env.BOT_MODEL_BACKEND === 'claude-code'
  ? createClaudeCodeAdapter()
  : new Anthropic();

const replyer = createReplyer({ client: bitrixClient, botId: botConfig.botId, botToken: botConfig.botToken });
const { reply, notifyAction, replyWithFile } = replyer;
const rateLimiter = createRateLimiter();
const pendingActions = createPendingActionsStore({ filePath: new URL('./data/pending-actions.json', import.meta.url).pathname });
const memory = createMemoryStore({ dataDir: new URL('./data', import.meta.url).pathname });
const conversationHistory = createConversationHistory({ dataDir: new URL('./data', import.meta.url).pathname });
const auditLog = createAuditLog(new URL('./data/audit.jsonl', import.meta.url).pathname);
const agentLoop = createAgentLoop({ anthropic, pendingActions, memory, auditLog, conversationHistory });

const msntalkWebhookSecret = process.env.MSNTALK_WEBHOOK_SECRET;
if (!msntalkWebhookSecret) {
  throw new Error(
    'Defina MSNTALK_WEBHOOK_SECRET (segredo usado no path do webhook do MSN Talk, ' +
    'ex.: https://<host>/msntalk-events/<MSNTALK_WEBHOOK_SECRET>) antes de subir o bot.'
  );
}
const msntalkTicketUrlTemplate = process.env.MSNTALK_TICKET_URL_TEMPLATE;
const msntalkThreadStore = createThreadStore({ filePath: new URL('./data/msntalk-threads.json', import.meta.url).pathname });
const msntalkPendingStore = createPendingStore({ filePath: new URL('./data/msntalk-pending.json', import.meta.url).pathname });

const msntalkAdditionalContactsIndex = createAdditionalContactsIndex({
  filePath: new URL('./data/msntalk-additional-contacts.json', import.meta.url).pathname,
});
// Cliente Bitrix dedicado a essa varredura em segundo plano — evita que
// milhares de chamadas do refresh fiquem na frente das sincronizações em
// tempo real do MSN Talk na fila do rate-limiter (cada client tem a sua).
// Só que a cota de chamadas por minuto do Bitrix é por WEBHOOK, não por
// client — em produção, rodar esse client no ritmo padrão (2 chamadas/s)
// ao mesmo tempo que o tráfego real do webhook estourou a cota e travou o
// refresh inteiro com QUERY_LIMIT_EXCEEDED (HTTP 503) logo na primeira
// tentativa. Por isso esse client roda bem mais devagar (1 chamada a cada
// 1.5s) — o refresh não é sensível a tempo, mas o tráfego em tempo real é.
const additionalContactsRefreshClient = new Bitrix24Client(resolveWebhook(), { minDelay: 1500 });
const ADDITIONAL_CONTACTS_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
// Em produção, um ciclo completo passou a levar horas (cota do Bitrix
// disputada com o tráfego real do webhook) — bem mais que os 30min do
// intervalo. Sem essa guarda, cada novo "tick" do setInterval disparava
// outra varredura por cima da anterior ainda em andamento, as duas
// competindo pela mesma cota e falhando mais (seguidas de vários 502/503).
let additionalContactsRefreshInFlight = false;
async function runAdditionalContactsRefresh() {
  if (additionalContactsRefreshInFlight) return;
  additionalContactsRefreshInFlight = true;
  try {
    await refreshAdditionalContacts({ client: additionalContactsRefreshClient, index: msntalkAdditionalContactsIndex });
  } catch (err) {
    console.error('msntalk: refreshAdditionalContacts failed', err);
  } finally {
    additionalContactsRefreshInFlight = false;
  }
}
runAdditionalContactsRefresh();
setInterval(runAdditionalContactsRefresh, ADDITIONAL_CONTACTS_REFRESH_INTERVAL_MS);

// Reconsulta periodicamente os telefones com conversa pendente (sem match
// ainda) — cobre, por exemplo, alguém corrigir/cadastrar o número no
// contato depois que a conversa já tinha ficado pendente, sem precisar
// esperar o cliente escrever de novo. Bem mais leve que o refresh de
// contatos adicionais (só os telefones realmente pendentes, não todo
// lead/negócio aberto do portal), então pode rodar bem mais seguido.
const reconcilePendingClient = new Bitrix24Client(resolveWebhook(), { minDelay: 1000 });
const RECONCILE_PENDING_INTERVAL_MS = 15 * 60 * 1000;
let reconcilePendingInFlight = false;
async function runReconcilePending() {
  if (reconcilePendingInFlight) return;
  reconcilePendingInFlight = true;
  try {
    await reconcilePending({
      client: reconcilePendingClient,
      pendingStore: msntalkPendingStore,
      threadStore: msntalkThreadStore,
      additionalContactsIndex: msntalkAdditionalContactsIndex,
      ticketUrlTemplate: msntalkTicketUrlTemplate,
      auditLog,
    });
  } catch (err) {
    console.error('msntalk: reconcilePending failed', err);
  } finally {
    reconcilePendingInFlight = false;
  }
}
runReconcilePending();
setInterval(runReconcilePending, RECONCILE_PENDING_INTERVAL_MS);

const app = createApp({
  botConfig,
  agentLoop,
  reply,
  notifyAction,
  replyWithFile,
  rateLimiter,
  bitrixClient,
  auditLog,
  msntalkWebhookSecret,
  msntalkTicketUrlTemplate,
  msntalkThreadStore,
  msntalkPendingStore,
  msntalkAdditionalContactsIndex,
});

app.listen(PORT, () => {
  console.log(`Bot Server escutando na porta ${PORT}`);
});
