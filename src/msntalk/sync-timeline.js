import { timelineAdd, timelineCommentUpdate, crmUpdate, crmCreate } from '../tools/crm.js';
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

// Mensagem de notificação de formulário preenchido (ex: anúncio de geração
// de leads) — vem com uma frase fixa seguida de campos "Rótulo: valor", um
// por linha, com os dados de quem preencheu. Usa startsWith (não igualdade
// exata como NEW_LEAD_TRIGGERS) porque o texto completo varia conforme os
// campos preenchidos no formulário.
const FORM_SUBMISSION_TRIGGER = 'Olá! Preenchi seu formulário e gostaria de saber mais sobre sua empresa.';

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

// Extrai os pares "Rótulo: valor" (um por linha) do corpo da mensagem de
// formulário, ex.: "Email: fulano@ex.com" -> { Email: 'fulano@ex.com' }.
function parseFormFields(text) {
  const fields = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (match) fields[match[1].trim()] = match[2].trim();
  }
  return fields;
}

async function createLeadFromFormSubmission(event) {
  const formFields = parseFormFields(event.text);
  const fullName = formFields['Full name'] || event.contactName || 'Contato via formulário';
  const [firstName, ...lastNameParts] = fullName.split(' ');
  const phone = formFields['Phone number'] || event.phone;

  const fields = {
    TITLE: `Formulário — ${fullName}`,
    NAME: firstName,
    STATUS_ID: INBOUND_LEAD_STATUS_ID,
    COMMENTS: event.text,
    PHONE: [{ VALUE: phone, VALUE_TYPE: 'WORK' }],
  };
  if (lastNameParts.length > 0) fields.LAST_NAME = lastNameParts.join(' ');
  if (formFields['Email']) fields.EMAIL = [{ VALUE: formFields['Email'], VALUE_TYPE: 'WORK' }];
  if (formFields['Job title']) fields.POST = formFields['Job title'];
  if (formFields['Company name']) fields.COMPANY_TITLE = formFields['Company name'];

  const { created_id: leadId } = await crmCreate({ entity: 'lead', fields });

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

export async function syncTimeline({ event, client, auditLog, ticketUrlTemplate, threadStore, pendingStore, additionalContactsIndex }) {
  let groups = await findCrmEntity(client, event.phone, additionalContactsIndex);

  if (!groups) {
    const trimmedText = event.text?.trim() ?? '';
    let created = null;
    if (NEW_LEAD_TRIGGERS.includes(trimmedText)) {
      created = await createLeadFromSiteMessage(event);
    } else if (trimmedText.startsWith(FORM_SUBMISSION_TRIGGER)) {
      created = await createLeadFromFormSubmission(event);
    }
    if (created) {
      groups = [created];
      auditLog.logAction({
        tool: 'msntalk-sync',
        params: { phone: event.phone, ticketId: event.ticketId, entity_id: created.entity_ids[0] },
        result: 'lead-created',
      });
    }
  }

  if (!groups) {
    // Sem lead/negócio aberto pra esse telefone agora — a mensagem não pode
    // ir pra timeline ainda, mas guardamos o texto: se esse telefone vier a
    // casar com um lead/negócio mais tarde (cadastro do número, mudança de
    // etapa etc.), syncTimeline recupera essas linhas em vez de perdê-las.
    pendingStore?.appendPending(event.phone, buildLine(event));
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
  const backfillLines = pendingStore?.takePending(event.phone) ?? [];
  if (backfillLines.length > 0) {
    auditLog.logAction({
      tool: 'msntalk-sync',
      params: { phone: event.phone, ticketId: event.ticketId, entity_id: groups[0].entity_ids[0], recovered: backfillLines.length },
      result: 'backfill',
    });
  }

  // Um contato pode ter vários negócios/leads abertos ao mesmo tempo — e, num
  // caso real observado em produção, até um Lead E um Negócio abertos
  // simultaneamente para o mesmo contato (ex: um Lead antigo nunca fechado
  // depois que o Negócio foi criado) — então sincronizamos a mesma mensagem
  // na timeline de TODOS os matches abertos, de todos os tipos, não só no
  // primeiro.
  const rawThread = threadStore.getThread(event.ticketId);
  // Threads antigas guardavam um único commentId (de quando só existia um
  // match por ticket, sempre do mesmo tipo); migramos preservando esse
  // comentário para o primeiro entity_id da lista.
  const legacyCommentId = rawThread && !rawThread.comments ? rawThread.commentId : null;
  const comments = rawThread?.comments ?? {};
  const lines = [...backfillLines, ...(rawThread?.lines ?? []), buildLine(event)].slice(-MAX_LINES);
  const comment = buildCommentText({ ticketId: event.ticketId, lines, ticketUrlTemplate });

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
      }

      await crmUpdate({
        entity: group.entity,
        id: entityId,
        fields: { [LAST_MESSAGE_FIELD]: event.timestamp },
      });
      isFirstEntityOverall = false;
    }
  }

  threadStore.saveThread(event.ticketId, { comments: newComments, lines });

  return { matched: true, groups };
}
