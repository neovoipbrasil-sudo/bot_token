import { timelineAdd, timelineCommentUpdate } from '../tools/crm.js';
import { findCrmEntity } from './find-crm-entity.js';

// Teto de mensagens guardadas por conversa — evita que o comentário cresça
// sem limite em atendimentos longos; mensagens mais antigas vão caindo.
const MAX_LINES = 30;

// Nome do contato do WhatsApp identifica quem mandou a mensagem — importante
// quando o lead/deal tem mais de um contato vinculado e "Cliente" sozinho
// não diria qual deles está falando.
function senderLabel(event) {
  if (event.direction === 'outbound') return 'SDR';
  return event.contactName || 'Cliente';
}

function formatTimestamp(timestamp) {
  const date = timestamp ? new Date(timestamp) : new Date();
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('day')}/${get('month')} ${get('hour')}:${get('minute')}`;
}

function buildLine(event) {
  return `[${formatTimestamp(event.timestamp)}] ${senderLabel(event)}: ${event.text}`;
}

function buildCommentText({ ticketId, lines, ticketUrlTemplate }) {
  const parts = [`[MSN Talk] Ticket #${ticketId}`];
  if (ticketUrlTemplate) parts.push(ticketUrlTemplate.replace('{ticketId}', ticketId));
  parts.push('', ...lines);
  return parts.join('\n');
}

export async function syncTimeline({ event, client, auditLog, ticketUrlTemplate, threadStore }) {
  const found = await findCrmEntity(client, event.phone);

  if (!found) {
    auditLog.logAction({
      tool: 'msntalk-sync',
      params: { phone: event.phone, ticketId: event.ticketId },
      result: 'no-match',
    });
    return { matched: false };
  }

  const thread = threadStore.getThread(event.ticketId) ?? { commentId: null, lines: [] };
  const lines = [...thread.lines, buildLine(event)].slice(-MAX_LINES);
  const comment = buildCommentText({ ticketId: event.ticketId, lines, ticketUrlTemplate });

  if (thread.commentId) {
    await timelineCommentUpdate({ id: thread.commentId, comment });
    threadStore.saveThread(event.ticketId, { commentId: thread.commentId, lines });
  } else {
    const { comment_id } = await timelineAdd({ entity: found.entity, entity_id: found.entity_id, comment });
    threadStore.saveThread(event.ticketId, { commentId: comment_id, lines });
  }

  return { matched: true, entity: found.entity, entity_id: found.entity_id };
}
