import express from 'express';

export function createApp({ botConfig, agentLoop, reply, rateLimiter }) {
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
    const text = req.body.data?.message?.text;
    if (!dialogId || !userId || !text) return;

    handleEvent({ dialogId, userId, text }).catch(() => {
      // handleEvent already replies to the user on every error path; this catch
      // only guards against reply() itself throwing, which we can't recover from.
    });

    async function handleEvent({ dialogId, userId, text }) {
      const rl = rateLimiter.checkAndConsume(userId);
      if (!rl.allowed) {
        await reply(dialogId, 'Você está enviando mensagens rápido demais, aguarde um instante e tente de novo.');
        return;
      }

      try {
        const { replies } = await agentLoop.handleMessage({ userId, dialogId, text });
        for (const msg of replies) await reply(dialogId, msg);
      } catch (err) {
        await reply(dialogId, 'Não consegui processar sua mensagem agora, tenta de novo em instantes.');
      }
    }
  });

  return app;
}
