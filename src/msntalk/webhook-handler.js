export function parseMsnTalkEvent(body) {
  const ticket = body?.ticket;
  const phone = ticket?.contact?.number;
  if (!phone) return null;

  const ticketId = ticket.id;
  const protocol = ticket.protocol;

  if (body.method === 'message') {
    const text = body.msg?.text ?? body.msg?.body;
    if (!text) return null;
    return {
      phone,
      text,
      direction: body.msg?.fromMe === true ? 'outbound' : 'inbound',
      ticketId,
      protocol,
    };
  }

  if (body.method === 'message_send_uazapi') {
    const text = body.msg?.message;
    if (!text) return null;
    return { phone, text, direction: 'outbound', ticketId, protocol };
  }

  return null;
}
