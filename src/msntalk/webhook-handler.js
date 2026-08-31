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

// O MSN Talk às vezes manda msg.text/msg.body como objeto (ex: payload de
// mídia com legenda) em vez de string. syncTimeline faz event.text.trim(),
// que estoura TypeError e derruba a mensagem inteira sem sincronizar nada.
// Normalizamos pra string aqui, na borda, pra nunca propagar um não-string.
function toMessageText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return null;
  return JSON.stringify(value);
}

export function parseMsnTalkEvent(body) {
  const ticket = body?.ticket;
  const phone = ticket?.contact?.number;
  if (!phone) return null;

  const ticketId = ticket.id;
  const protocol = ticket.protocol;
  const contactName = ticket.contact?.name || null;

  if (body.method === 'message') {
    const text = toMessageText(body.msg?.text ?? body.msg?.body);
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
    const text = toMessageText(body.msg?.message);
    if (!text) return null;
    return { phone, text, direction: 'outbound', ticketId, protocol, contactName, timestamp: new Date().toISOString() };
  }

  return null;
}
