import { timelineAdd, timelineCommentUpdate } from '../tools/crm.js';
import { findCrmEntity } from './find-crm-entity.js';

const DIRECTION_LABEL = { inbound: 'Cliente', outbound: 'SDR' };

// Teto de mensagens guardadas por conversa — evita que o comentário cresça
// sem limite em atendimentos longos; mensagens mais antigas vão caindo.
const MAX_LINES = 30;

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
  const lines = [...thread.lines, `${DIRECTION_LABEL[event.direction]}: ${event.text}`].slice(-MAX_LINES);
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
