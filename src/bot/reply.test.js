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

  it('calls imbot.v2.Chat.InputAction.notify with the bot id, bot token, dialog id, status code and duration', async () => {
    const client = { call: vi.fn().mockResolvedValue({ result: { result: true } }) };
    const { notifyAction } = createReplyer({ client, botId: 456, botToken: 'my_bot_token' });

    await notifyAction('dialog-42', 'IMBOT_AGENT_ACTION_THINKING', 30);

    expect(client.call).toHaveBeenCalledWith('imbot.v2.Chat.InputAction.notify', {
      botId: 456,
      botToken: 'my_bot_token',
      dialogId: 'dialog-42',
      statusMessageCode: 'IMBOT_AGENT_ACTION_THINKING',
      duration: 30,
    });
  });

  it('defaults notifyAction duration to 60 seconds', async () => {
    const client = { call: vi.fn().mockResolvedValue({ result: { result: true } }) };
    const { notifyAction } = createReplyer({ client, botId: 456, botToken: 'my_bot_token' });

    await notifyAction('dialog-42', 'IMBOT_AGENT_ACTION_SEARCHING');

    expect(client.call).toHaveBeenCalledWith('imbot.v2.Chat.InputAction.notify', expect.objectContaining({ duration: 60 }));
  });

  it('calls imbot.v2.Chat.Message.send with a FILE attachment block when replying with a file', async () => {
    const client = { call: vi.fn().mockResolvedValue({ result: { id: 1 } }) };
    const { replyWithFile } = createReplyer({ client, botId: 456, botToken: 'my_bot_token' });

    await replyWithFile('dialog-42', 'Aqui está o relatório!', { name: 'relatorio.pdf', downloadUrl: 'https://x/download', size: 1024 });

    expect(client.call).toHaveBeenCalledWith('imbot.v2.Chat.Message.send', {
      botId: 456,
      botToken: 'my_bot_token',
      dialogId: 'dialog-42',
      fields: {
        message: 'Aqui está o relatório!',
        attach: { BLOCKS: [{ FILE: [{ NAME: 'relatorio.pdf', LINK: 'https://x/download', SIZE: 1024 }] }] },
      },
    });
  });
});
