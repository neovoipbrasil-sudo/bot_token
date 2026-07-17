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
  };
}
