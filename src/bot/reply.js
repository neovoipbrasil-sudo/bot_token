export function createReplyer({ client, botId, botToken }) {
  return {
    async reply(dialogId, message) {
      return client.call('imbot.v2.Chat.Message.send', {
        botId,
        botToken,
        dialogId,
        fields: { message },
      });
    },
    async notifyAction(dialogId, statusMessageCode, duration = 60) {
      return client.call('imbot.v2.Chat.InputAction.notify', {
        botId,
        botToken,
        dialogId,
        statusMessageCode,
        duration,
      });
    },
    async replyWithFile(dialogId, message, file) {
      return client.call('imbot.v2.Chat.Message.send', {
        botId,
        botToken,
        dialogId,
        fields: {
          message,
          attach: {
            BLOCKS: [{ FILE: [{ NAME: file.name, LINK: file.downloadUrl, SIZE: file.size }] }],
          },
        },
      });
    },
  };
}
