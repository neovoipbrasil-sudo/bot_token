import { describe, it, expect, vi, beforeEach } from 'vitest';

const findCrmEntityMock = vi.fn();
const timelineAddMock = vi.fn().mockResolvedValue({ comment_id: 297878, success: true });
const timelineCommentUpdateMock = vi.fn().mockResolvedValue({ success: true });
const crmUpdateMock = vi.fn().mockResolvedValue({ success: true });
const crmCreateMock = vi.fn();

vi.mock('./find-crm-entity.js', () => ({ findCrmEntity: findCrmEntityMock }));
vi.mock('../tools/crm.js', () => ({
  timelineAdd: timelineAddMock,
  timelineCommentUpdate: timelineCommentUpdateMock,
  crmUpdate: crmUpdateMock,
  crmCreate: crmCreateMock,
}));

const { syncTimeline } = await import('./sync-timeline.js');

// 2026-07-28T20:11:00.000Z == 28/07 17:11 em America/Sao_Paulo (UTC-3)
const TS = '2026-07-28T20:11:00.000Z';

function baseEvent(overrides = {}) {
  return {
    phone: '556121090177',
    text: 'Bom dia',
    direction: 'inbound',
    ticketId: 92315,
    protocol: '2026200710580392315',
    contactName: 'Maria Souza',
    timestamp: TS,
    ...overrides,
  };
}

function makeThreadStore(initial = {}) {
  const data = { ...initial };
  return {
    getThread: vi.fn((ticketId) => data[ticketId] ?? null),
    saveThread: vi.fn((ticketId, thread) => { data[ticketId] = thread; }),
  };
}

describe('syncTimeline', () => {
  beforeEach(() => {
    findCrmEntityMock.mockClear();
    timelineAddMock.mockClear();
    timelineCommentUpdateMock.mockClear();
    crmUpdateMock.mockClear();
    crmCreateMock.mockClear();
  });

  it('creates a new timeline comment for the first message of a ticket', async () => {
    findCrmEntityMock.mockResolvedValueOnce({ entity: 'deal', entity_id: 555 });
    const threadStore = makeThreadStore();
    const auditLog = { logAction: vi.fn() };

    const result = await syncTimeline({ event: baseEvent(), client: {}, auditLog, threadStore });

    expect(result).toEqual({ matched: true, entity: 'deal', entity_id: 555 });
    expect(timelineAddMock).toHaveBeenCalledWith({
      entity: 'deal',
      entity_id: 555,
      comment: '[MSN Talk] Ticket #92315\n\n[28/07 17:11] Maria Souza: Bom dia',
    });
    expect(timelineCommentUpdateMock).not.toHaveBeenCalled();
    expect(threadStore.saveThread).toHaveBeenCalledWith(92315, {
      commentId: 297878,
      lines: ['[28/07 17:11] Maria Souza: Bom dia'],
    });
    expect(crmUpdateMock).toHaveBeenCalledWith({
      entity: 'deal',
      id: 555,
      fields: { UF_CRM_LASTMSNTALK: TS },
    });
    expect(auditLog.logAction).not.toHaveBeenCalled();
  });

  it('falls back to "Cliente" when the ticket has no WhatsApp contact name', async () => {
    findCrmEntityMock.mockResolvedValueOnce({ entity: 'deal', entity_id: 555 });
    const threadStore = makeThreadStore();
    const auditLog = { logAction: vi.fn() };

    await syncTimeline({ event: baseEvent({ contactName: null }), client: {}, auditLog, threadStore });

    expect(timelineAddMock).toHaveBeenCalledWith({
      entity: 'deal',
      entity_id: 555,
      comment: '[MSN Talk] Ticket #92315\n\n[28/07 17:11] Cliente: Bom dia',
    });
  });

  it('updates the existing comment instead of creating a new one for a known ticket', async () => {
    findCrmEntityMock.mockResolvedValueOnce({ entity: 'lead', entity_id: 111 });
    const threadStore = makeThreadStore({
      92315: { commentId: 297878, lines: ['[28/07 17:11] Maria Souza: Bom dia'] },
    });
    const auditLog = { logAction: vi.fn() };

    await syncTimeline({
      event: baseEvent({ direction: 'outbound', text: 'Já te respondo', timestamp: '2026-07-28T20:13:00.000Z' }),
      client: {},
      auditLog,
      threadStore,
    });

    expect(timelineAddMock).not.toHaveBeenCalled();
    expect(timelineCommentUpdateMock).toHaveBeenCalledWith({
      id: 297878,
      comment: '[MSN Talk] Ticket #92315\n\n[28/07 17:11] Maria Souza: Bom dia\n[28/07 17:13] SDR: Já te respondo',
    });
    expect(threadStore.saveThread).toHaveBeenCalledWith(92315, {
      commentId: 297878,
      lines: ['[28/07 17:11] Maria Souza: Bom dia', '[28/07 17:13] SDR: Já te respondo'],
    });
    expect(crmUpdateMock).toHaveBeenCalledWith({
      entity: 'lead',
      id: 111,
      fields: { UF_CRM_LASTMSNTALK: '2026-07-28T20:13:00.000Z' },
    });
  });

  it('includes the resolved ticket link when a template is provided', async () => {
    findCrmEntityMock.mockResolvedValueOnce({ entity: 'deal', entity_id: 555 });
    const threadStore = makeThreadStore();
    const auditLog = { logAction: vi.fn() };

    await syncTimeline({
      event: baseEvent(),
      client: {},
      auditLog,
      threadStore,
      ticketUrlTemplate: 'https://app.msntalk.neovoip.com.br/atendimento?ticketId={ticketId}',
    });

    expect(timelineAddMock).toHaveBeenCalledWith({
      entity: 'deal',
      entity_id: 555,
      comment: '[MSN Talk] Ticket #92315\nhttps://app.msntalk.neovoip.com.br/atendimento?ticketId=92315\n\n[28/07 17:11] Maria Souza: Bom dia',
    });
  });

  it('keeps only the most recent 30 lines once the thread grows past the cap', async () => {
    findCrmEntityMock.mockResolvedValueOnce({ entity: 'lead', entity_id: 111 });
    const existingLines = Array.from({ length: 30 }, (_, i) => `[28/07 17:${String(i).padStart(2, '0')}] Maria Souza: msg ${i}`);
    const threadStore = makeThreadStore({ 92315: { commentId: 297878, lines: existingLines } });
    const auditLog = { logAction: vi.fn() };

    await syncTimeline({ event: baseEvent({ text: 'msg nova' }), client: {}, auditLog, threadStore });

    const savedLines = threadStore.saveThread.mock.calls[0][1].lines;
    expect(savedLines).toHaveLength(30);
    expect(savedLines[0]).toBe(existingLines[1]);
    expect(savedLines.at(-1)).toBe('[28/07 17:11] Maria Souza: msg nova');
  });

  it('creates a Contact and a Deal when an unmatched phone sends the exact site opening message', async () => {
    findCrmEntityMock.mockResolvedValueOnce(null);
    crmCreateMock
      .mockResolvedValueOnce({ created_id: 9001 }) // contact
      .mockResolvedValueOnce({ created_id: 9002 }); // deal
    const threadStore = makeThreadStore();
    const auditLog = { logAction: vi.fn() };

    const result = await syncTimeline({
      event: baseEvent({ text: 'Olá, vim pelo site e gostaria de mais informações.' }),
      client: {},
      auditLog,
      threadStore,
    });

    expect(crmCreateMock).toHaveBeenCalledWith({
      entity: 'contact',
      fields: { NAME: 'Maria Souza', PHONE: [{ VALUE: '556121090177', VALUE_TYPE: 'WORK' }] },
    });
    expect(crmCreateMock).toHaveBeenCalledWith({
      entity: 'deal',
      fields: { TITLE: 'Site — Maria Souza', CONTACT_ID: 9001 },
    });
    expect(result).toEqual({ matched: true, entity: 'deal', entity_id: 9002 });
    expect(timelineAddMock).toHaveBeenCalledWith({
      entity: 'deal',
      entity_id: 9002,
      comment: expect.stringContaining('Olá, vim pelo site e gostaria de mais informações.'),
    });
    expect(auditLog.logAction).toHaveBeenCalledWith({
      tool: 'msntalk-sync',
      params: { phone: '556121090177', ticketId: 92315, entity_id: 9002 },
      result: 'deal-created',
    });
  });

  it('does not create a Deal for an unmatched phone sending a message that only resembles the site trigger', async () => {
    findCrmEntityMock.mockResolvedValueOnce(null);
    const threadStore = makeThreadStore();
    const auditLog = { logAction: vi.fn() };

    const result = await syncTimeline({
      event: baseEvent({ text: 'Olá, vim pelo site' }),
      client: {},
      auditLog,
      threadStore,
    });

    expect(result).toEqual({ matched: false });
    expect(crmCreateMock).not.toHaveBeenCalled();
    expect(auditLog.logAction).toHaveBeenCalledWith({
      tool: 'msntalk-sync',
      params: { phone: '556121090177', ticketId: 92315 },
      result: 'no-match',
    });
  });

  it('does not create a Deal for the site trigger message when the phone already matches a CRM entity', async () => {
    findCrmEntityMock.mockResolvedValueOnce({ entity: 'deal', entity_id: 555 });
    const threadStore = makeThreadStore();
    const auditLog = { logAction: vi.fn() };

    const result = await syncTimeline({
      event: baseEvent({ text: 'Olá, vim pelo site e gostaria de mais informações.' }),
      client: {},
      auditLog,
      threadStore,
    });

    expect(result).toEqual({ matched: true, entity: 'deal', entity_id: 555 });
    expect(crmCreateMock).not.toHaveBeenCalled();
  });

  it('logs to the audit log and skips the timeline entirely when no CRM entity matches', async () => {
    findCrmEntityMock.mockResolvedValueOnce(null);
    const threadStore = makeThreadStore();
    const auditLog = { logAction: vi.fn() };

    const result = await syncTimeline({ event: baseEvent(), client: {}, auditLog, threadStore });

    expect(result).toEqual({ matched: false });
    expect(timelineAddMock).not.toHaveBeenCalled();
    expect(timelineCommentUpdateMock).not.toHaveBeenCalled();
    expect(threadStore.saveThread).not.toHaveBeenCalled();
    expect(crmUpdateMock).not.toHaveBeenCalled();
    expect(auditLog.logAction).toHaveBeenCalledWith({
      tool: 'msntalk-sync',
      params: { phone: '556121090177', ticketId: 92315 },
      result: 'no-match',
    });
  });
});
