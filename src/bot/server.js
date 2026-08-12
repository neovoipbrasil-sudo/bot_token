import express from 'express';
import { parseMsnTalkEvent } from '../msntalk/webhook-handler.js';
import { syncTimeline } from '../msntalk/sync-timeline.js';
import { readAttachment } from './attachment-reader.js';

export function createApp({
  botConfig,
  agentLoop,
  reply,
  notifyAction = async () => {},
  replyWithFile = async (dialogId, message) => reply(dialogId, message),
  rateLimiter,
  bitrixClient,
  auditLog,
  msntalkWebhookSecret,
  msntalkTicketUrlTemplate,
  msntalkThreadStore,
}) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  const expectedToken = 'custom' + botConfig.botToken;

  app.post('/bitrix-events', (req, res) => {
    const token = req.body?.auth?.application_token;
    if (token !== expectedToken) {
      return res.status(403).send('forbidden');
    }

    // Ack immediately — Bitrix24 expects a fast response, the actual work happens after.
    res.status(200).send('ok');

    if (req.body.event !== 'ONIMBOTV2MESSAGEADD') return;

    const dialogId = req.body.data?.chat?.dialogId;
    const userId = req.body.data?.user?.id;
    const text = req.body.data?.message?.text || '';
    const fileIds = req.body.data?.message?.params?.FILE_ID || [];
    if (!dialogId || !userId || (!text && fileIds.length === 0)) return;

    handleEvent({ dialogId, userId, text, fileIds }).catch(() => {
      // handleEvent already replies to the user on every error path; this catch
      // only guards against reply() itself throwing, which we can't recover from.
    });

    async function handleEvent({ dialogId, userId, text, fileIds }) {
      const rl = rateLimiter.checkAndConsume(userId);
      if (!rl.allowed) {
        await reply(dialogId, 'Você está enviando mensagens rápido demais, aguarde um instante e tente de novo.');
        return;
      }

      let keepThinkingAlive = true;
      notifyAction(dialogId, 'IMBOT_AGENT_ACTION_THINKING', 60).catch(() => {});
      const thinkingInterval = setInterval(() => {
        if (keepThinkingAlive) notifyAction(dialogId, 'IMBOT_AGENT_ACTION_THINKING', 60).catch(() => {});
      }, 40_000);

      try {
        let fullText = text;
        for (const fileId of fileIds) {
          let attachmentText;
          try {
            const fileRes = await bitrixClient.call('disk.file.get', { id: fileId });
            const file = fileRes.result;
            ({ text: attachmentText } = await readAttachment({
              url: file.DOWNLOAD_URL,
              filename: file.NAME,
              size: Number(file.SIZE),
              portalHost: bitrixClient.portal,
            }));
          } catch (err) {
            attachmentText = `[Anexo ${fileId}]\nNão consegui ler esse anexo: ${err.message}`;
          }
          fullText = fullText ? `${fullText}\n\n${attachmentText}` : attachmentText;
        }

        const { replies } = await agentLoop.handleMessage({ userId, dialogId, text: fullText });
        for (const msg of replies) {
          if (typeof msg === 'string') await reply(dialogId, msg);
          else await replyWithFile(dialogId, msg.message, msg.file);
        }
      } catch (err) {
        console.error('bitrix-events: handleMessage failed:', err.message);
        await reply(dialogId, 'Não consegui processar sua mensagem agora, tenta de novo em instantes.');
      } finally {
        keepThinkingAlive = false;
        clearInterval(thinkingInterval);
      }
    }
  });

  app.post('/msntalk-events/:secret', (req, res) => {
    if (req.params.secret !== msntalkWebhookSecret) {
      return res.status(404).send('not found');
    }

    // Ack immediately — same "fast ack, process after" pattern as /bitrix-events.
    res.status(200).send('ok');

    const event = parseMsnTalkEvent(req.body);
    if (!event) return;

    syncTimeline({
      event,
      client: bitrixClient,
      auditLog,
      ticketUrlTemplate: msntalkTicketUrlTemplate,
      threadStore: msntalkThreadStore,
    }).catch((err) => {
      // MSN Talk has no retry mechanism we can hook into, so we can't propagate
      // this error back to the sender — we can only make it observable on our
      // side: log it and record an audit-log entry (syncTimeline's own
      // no-match audit entry is written on its clean success path, never here).
      console.error('msntalk-events: syncTimeline failed', err);
      auditLog.logAction({
        tool: 'msntalk-sync',
        params: { phone: event.phone, ticketId: event.ticketId },
        result: 'error',
      });
    });
  });

  return app;
}
