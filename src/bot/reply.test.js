import { describe, it, expect, vi } from 'vitest';
import { createReplyer } from './reply.js';

describe('reply', () => {
  it('calls imbot.v2.Chat.Message.send with the bot id, bot token, dialog id and message', async () => {
    const client = { call: vi.fn().mockResolvedValue({ result: { id: 123 } }) };
    const { reply } = createReplyer({ client, botId: 456, botToken: 'my_bot_token' });

    await reply('dialog-42', 'Olá, tudo certo!');

    expect(client.call).toHaveBeenCalledWith('imbot.v2.Chat.Message.send', {
      botId: 456,
      botToken: 'my_bot_token',
      dialogId: 'dialog-42',
      fields: { message: 'Olá, tudo certo!' },
    });
  });

  it('propagates errors from the client so callers can handle them', async () => {
    const client = { call: vi.fn().mockRejectedValue(new Error('Bitrix24 error [1]: boom')) };
    const { reply } = createReplyer({ client, botId: 456, botToken: 'my_bot_token' });

    await expect(reply('dialog-42', 'oi')).rejects.toThrow('boom');
  });
});
