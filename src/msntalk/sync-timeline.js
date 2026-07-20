import { timelineAdd } from '../tools/crm.js';
import { findCrmEntity } from './find-crm-entity.js';

const DIRECTION_LABEL = { inbound: 'Cliente', outbound: 'SDR' };

export async function syncTimeline({ event, client, auditLog, ticketUrlTemplate }) {
  const found = await findCrmEntity(client, event.phone);

  if (!found) {
    auditLog.logAction({
      tool: 'msntalk-sync',
      params: { phone: event.phone, ticketId: event.ticketId },
      result: 'no-match',
    });
    return { matched: false };
  }

  let comment = `[MSN Talk] ${DIRECTION_LABEL[event.direction]}: ${event.text}`;
  if (ticketUrlTemplate) {
    comment += `\n${ticketUrlTemplate.replace('{ticketId}', event.ticketId)}`;
  }

  await timelineAdd({ entity: found.entity, entity_id: found.entity_id, comment });
  return { matched: true, entity: found.entity, entity_id: found.entity_id };
}
