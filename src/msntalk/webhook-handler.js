// O MSN Talk já mandou msg.timestamp malformado em produção, o que fazia
// `new Date(...).toISOString()` estourar um RangeError síncrono e derrubar
// a mensagem inteira sem deixar rastro (nem audit log). Preferimos perder só
// o timestamp original a perder a mensagem.
function toIsoTimestamp(value) {
  if (value) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

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
      timestamp: toIsoTimestamp(body.msg?.timestamp),
    };
  }

  if (body.method === 'message_send_uazapi') {
    const text = body.msg?.message;
    if (!text) return null;
    return { phone, text, direction: 'outbound', ticketId, protocol, contactName, timestamp: new Date().toISOString() };
  }

  return null;
}
