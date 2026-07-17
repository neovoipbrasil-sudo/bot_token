import { readFileSync } from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { Bitrix24Client } from '../bitrix24/client.js';
import { resolveWebhook } from '../utils/resolve-webhook.js';
import { createApp } from './server.js';
import { createAgentLoop } from './agent-loop.js';
import { createReplyer } from './reply.js';
import { createRateLimiter } from './message-rate-limiter.js';
import { createPendingActionsStore } from './pending-actions.js';
import { createMemoryStore } from './memory.js';
import { createAuditLog } from './audit-log.js';

const PORT = process.env.BOT_PORT || 3300;

const botConfig = JSON.parse(readFileSync(new URL('./bot-config.json', import.meta.url), 'utf-8'));

const bitrixClient = new Bitrix24Client(resolveWebhook());
const anthropic = new Anthropic();

const reply = createReplyer({ client: bitrixClient, botId: botConfig.botId, botToken: botConfig.botToken }).reply;
const rateLimiter = createRateLimiter();
const pendingActions = createPendingActionsStore({ filePath: new URL('./data/pending-actions.json', import.meta.url).pathname });
const memory = createMemoryStore({ dataDir: new URL('./data', import.meta.url).pathname });
const auditLog = createAuditLog(new URL('./data/audit.jsonl', import.meta.url).pathname);
const agentLoop = createAgentLoop({ anthropic, pendingActions, memory, auditLog });

const app = createApp({ botConfig, agentLoop, reply, rateLimiter });

app.listen(PORT, () => {
  console.log(`Bot Server escutando na porta ${PORT}`);
});
