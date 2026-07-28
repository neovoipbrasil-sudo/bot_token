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

const PORT = process.env.BOT_PORT || 3300;

const botConfig = loadBotConfig({ filePath: new URL('./bot-config.json', import.meta.url) });

const bitrixClient = new Bitrix24Client(resolveWebhook());
const anthropic = process.env.BOT_MODEL_BACKEND === 'claude-code'
  ? createClaudeCodeAdapter()
  : new Anthropic();

const replyer = createReplyer({ client: bitrixClient, botId: botConfig.botId, botToken: botConfig.botToken });
const { reply, notifyAction } = replyer;
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

const app = createApp({
  botConfig,
  agentLoop,
  reply,
  notifyAction,
  rateLimiter,
  bitrixClient,
  auditLog,
  msntalkWebhookSecret,
  msntalkTicketUrlTemplate,
  msntalkThreadStore,
});

app.listen(PORT, () => {
  console.log(`Bot Server escutando na porta ${PORT}`);
});
