export function parseMsnTalkEvent(body) {
  const ticket = body?.ticket;
  const phone = ticket?.contact?.number;
  if (!phone) return null;

  const ticketId = ticket.id;
  const protocol = ticket.protocol;
  const contactName = ticket.contact?.name || null;

  if (body.method === 'message') {
    const text = body.msg?.text ?? body.msg?.body;
    if (!text) return null;
    return {
      phone,
      text,
      direction: body.msg?.fromMe === true ? 'outbound' : 'inbound',
      ticketId,
      protocol,
      contactName,
      // O MSN Talk manda o horário real do envio só nesse método; para
      // message_send_uazapi (sem timestamp no payload) usamos o horário
      // de recebimento do webhook, que é praticamente o mesmo instante.
      timestamp: body.msg?.timestamp ? new Date(body.msg.timestamp).toISOString() : new Date().toISOString(),
    };
  }

  if (body.method === 'message_send_uazapi') {
    const text = body.msg?.message;
    if (!text) return null;
    return { phone, text, direction: 'outbound', ticketId, protocol, contactName, timestamp: new Date().toISOString() };
  }

  return null;
}
