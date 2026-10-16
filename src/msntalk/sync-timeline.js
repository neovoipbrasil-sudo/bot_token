import { timelineAdd, timelineCommentUpdate, timelinePin, crmUpdate, crmCreate } from '../tools/crm.js';
import { findCrmEntity } from './find-crm-entity.js';

// Teto de mensagens guardadas por conversa — evita que o comentário cresça
// sem limite em atendimentos longos; mensagens mais antigas vão caindo.
const MAX_LINES = 30;

// Mensagens de abertura padrão do site indicam um lead novo: se o telefone
// não bate com nada no CRM (found === null) e o texto é exatamente uma
// dessas frases, criamos um Lead na etapa "Inbound" em vez de só logar
// "no-match".
const NEW_LEAD_TRIGGERS = [
  'Olá, vim pelo site e gostaria de mais informações.',
];

// STATUS_ID da etapa "Inbound" no funil de Leads deste portal
// (crm.status.list, ENTITY_ID=STATUS).
const INBOUND_LEAD_STATUS_ID = 'UC_33H9R1';

async function createLeadFromSiteMessage(event) {
  const { created_id: leadId } = await crmCreate({
    entity: 'lead',
    fields: {
      TITLE: `Site — ${event.contactName || event.phone}`,
      NAME: event.contactName || 'Contato via site',
      PHONE: [{ VALUE: event.phone, VALUE_TYPE: 'WORK' }],
      STATUS_ID: INBOUND_LEAD_STATUS_ID,
    },
  });

  return { entity: 'lead', entity_ids: [leadId] };
}

// Campo customizado criado em Lead e Deal (crm.lead.userfield.add /
// crm.deal.userfield.add) só pra alimentar a coluna "Última msg MSN Talk"
// no Kanban — timeline comment sozinho não atualiza nenhum campo nativo.
const LAST_MESSAGE_FIELD = 'UF_CRM_LASTMSNTALK';

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

// Posta (cria ou atualiza) o mesmo comentário em todos os grupos/entity_ids
// encontrados para um ticket, fixando comentários novos e salvando o thread
// atualizado. Compartilhado entre syncTimeline (reage a mensagem nova) e
// reconcile-pending.js (reage, sem mensagem nova, a um telefone pendente que
// passou a bater com um lead/negócio — ex: alguém corrigiu o número no
// contato). `onEntitySynced`, se passado, roda depois de cada entidade
// sincronizada (syncTimeline usa pra atualizar UF_CRM_LASTMSNTALK; o
// reconcile não tem uma mensagem "nova" com timestamp real pra isso).
export async function postConversationToGroups({ groups, ticketId, lines, ticketUrlTemplate, threadStore, onEntitySynced }) {
  const cappedLines = lines.slice(-MAX_LINES);

  // Um contato pode ter vários negócios/leads abertos ao mesmo tempo — e, num
  // caso real observado em produção, até um Lead E um Negócio abertos
  // simultaneamente para o mesmo contato (ex: um Lead antigo nunca fechado
  // depois que o Negócio foi criado) — então sincronizamos a mesma mensagem
  // na timeline de TODOS os matches abertos, de todos os tipos, não só no
  // primeiro.
  const rawThread = threadStore.getThread(ticketId);
  // Threads antigas guardavam um único commentId (de quando só existia um
  // match por ticket, sempre do mesmo tipo); migramos preservando esse
  // comentário para o primeiro entity_id da lista.
  const legacyCommentId = rawThread && !rawThread.comments ? rawThread.commentId : null;
  const comments = rawThread?.comments ?? {};
  const comment = buildCommentText({ ticketId, lines: cappedLines, ticketUrlTemplate });

  const newComments = {};
  let isFirstEntityOverall = true;
  for (const group of groups) {
    for (const entityId of group.entity_ids) {
      // Chave composta "tipo:id" evita colisão entre um Lead e um Negócio
      // com o mesmo ID numérico agora que os dois podem coexistir no mesmo
      // ticket; comments[entityId] (chave antiga, sem o tipo) e
      // legacyCommentId cobrem registros salvos antes dessa mudança.
      const key = `${group.entity}:${entityId}`;
      const existingCommentId = comments[key] ?? comments[entityId] ?? (isFirstEntityOverall ? legacyCommentId : null);
      if (existingCommentId) {
        await timelineCommentUpdate({ id: existingCommentId, comment });
        newComments[key] = existingCommentId;
      } else {
        const { comment_id } = await timelineAdd({ entity: group.entity, entity_id: entityId, comment });
        newComments[key] = comment_id;
        // Fixa o comentário recém-criado pra conversa do MSN Talk ficar
        // visível no topo da timeline sem precisar abrir o histórico
        // inteiro. Só na criação — uma vez fixado, o Bitrix mantém assim
        // mesmo quando o conteúdo é atualizado depois. Erro aqui (ex: limite
        // de itens fixados do Bitrix atingido) não deve derrubar o sync.
        try {
          await timelinePin({ id: comment_id, entity: group.entity, entity_id: entityId });
        } catch (err) {
          console.error('msntalk: timelinePin failed', err);
        }
      }

      if (onEntitySynced) await onEntitySynced(group.entity, entityId);
      isFirstEntityOverall = false;
    }
  }

  threadStore.saveThread(ticketId, { comments: newComments, lines: cappedLines });
}

export async function syncTimeline({ event, client, auditLog, ticketUrlTemplate, threadStore, pendingStore, additionalContactsIndex }) {
  let groups = await findCrmEntity(client, event.phone, additionalContactsIndex);

  if (!groups && NEW_LEAD_TRIGGERS.includes(event.text?.trim())) {
    const created = await createLeadFromSiteMessage(event);
    groups = [created];
    auditLog.logAction({
      tool: 'msntalk-sync',
      params: { phone: event.phone, ticketId: event.ticketId, entity_id: created.entity_ids[0] },
      result: 'lead-created',
    });
  }

  if (!groups) {
    // Sem lead/negócio aberto pra esse telefone agora — a mensagem não pode
    // ir pra timeline ainda, mas guardamos o texto: se esse telefone vier a
    // casar com um lead/negócio mais tarde (cadastro do número, mudança de
    // etapa etc.), syncTimeline recupera essas linhas em vez de perdê-las.
    pendingStore?.appendPending(event.phone, buildLine(event), event.ticketId);
    auditLog.logAction({
      tool: 'msntalk-sync',
      params: { phone: event.phone, ticketId: event.ticketId },
      result: 'no-match',
    });
    return { matched: false };
  }

  // Mensagens que ficaram pendentes desse telefone (de tickets anteriores ou
  // do início desse mesmo ticket, antes do match funcionar) entram no início
  // da timeline — recuperação única, feita só quando ainda há algo pendente.
  const pending = pendingStore?.takePending(event.phone) ?? { lines: [] };
  if (pending.lines.length > 0) {
    auditLog.logAction({
      tool: 'msntalk-sync',
      params: { phone: event.phone, ticketId: event.ticketId, entity_id: groups[0].entity_ids[0], recovered: pending.lines.length },
      result: 'backfill',
    });
  }

  const rawThread = threadStore.getThread(event.ticketId);
  const lines = [...pending.lines, ...(rawThread?.lines ?? []), buildLine(event)];

  await postConversationToGroups({
    groups,
    ticketId: event.ticketId,
    lines,
    ticketUrlTemplate,
    threadStore,
    onEntitySynced: (entity, entityId) => crmUpdate({
      entity,
      id: entityId,
      fields: { [LAST_MESSAGE_FIELD]: event.timestamp },
    }),
  });

  return { matched: true, groups };
}
