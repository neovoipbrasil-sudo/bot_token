import { describe, it, expect, vi, beforeEach } from 'vitest';

const findCrmEntityMock = vi.fn();
const timelineAddMock = vi.fn().mockResolvedValue({ comment_id: 297878, success: true });
const timelineCommentUpdateMock = vi.fn().mockResolvedValue({ success: true });

vi.mock('./find-crm-entity.js', () => ({ findCrmEntity: findCrmEntityMock }));
vi.mock('../tools/crm.js', () => ({
  timelineAdd: timelineAddMock,
  timelineCommentUpdate: timelineCommentUpdateMock,
}));

const { syncTimeline } = await import('./sync-timeline.js');

function baseEvent(overrides = {}) {
  return {
    phone: '556121090177',
    text: 'Bom dia',
    direction: 'inbound',
    ticketId: 92315,
    protocol: '2026200710580392315',
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
      comment: '[MSN Talk] Ticket #92315\n\nCliente: Bom dia',
    });
    expect(timelineCommentUpdateMock).not.toHaveBeenCalled();
    expect(threadStore.saveThread).toHaveBeenCalledWith(92315, { commentId: 297878, lines: ['Cliente: Bom dia'] });
    expect(auditLog.logAction).not.toHaveBeenCalled();
  });

  it('updates the existing comment instead of creating a new one for a known ticket', async () => {
    findCrmEntityMock.mockResolvedValueOnce({ entity: 'lead', entity_id: 111 });
    const threadStore = makeThreadStore({ 92315: { commentId: 297878, lines: ['Cliente: Bom dia'] } });
    const auditLog = { logAction: vi.fn() };

    await syncTimeline({
      event: baseEvent({ direction: 'outbound', text: 'Já te respondo' }),
      client: {},
      auditLog,
      threadStore,
    });

    expect(timelineAddMock).not.toHaveBeenCalled();
    expect(timelineCommentUpdateMock).toHaveBeenCalledWith({
      id: 297878,
      comment: '[MSN Talk] Ticket #92315\n\nCliente: Bom dia\nSDR: Já te respondo',
    });
    expect(threadStore.saveThread).toHaveBeenCalledWith(92315, {
      commentId: 297878,
      lines: ['Cliente: Bom dia', 'SDR: Já te respondo'],
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
      comment: '[MSN Talk] Ticket #92315\nhttps://app.msntalk.neovoip.com.br/atendimento?ticketId=92315\n\nCliente: Bom dia',
    });
  });

  it('keeps only the most recent 30 lines once the thread grows past the cap', async () => {
    findCrmEntityMock.mockResolvedValueOnce({ entity: 'lead', entity_id: 111 });
    const existingLines = Array.from({ length: 30 }, (_, i) => `Cliente: msg ${i}`);
    const threadStore = makeThreadStore({ 92315: { commentId: 297878, lines: existingLines } });
    const auditLog = { logAction: vi.fn() };

    await syncTimeline({ event: baseEvent({ text: 'msg nova' }), client: {}, auditLog, threadStore });

    const savedLines = threadStore.saveThread.mock.calls[0][1].lines;
    expect(savedLines).toHaveLength(30);
    expect(savedLines[0]).toBe('Cliente: msg 1');
    expect(savedLines.at(-1)).toBe('Cliente: msg nova');
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
    expect(auditLog.logAction).toHaveBeenCalledWith({
      tool: 'msntalk-sync',
      params: { phone: '556121090177', ticketId: 92315 },
      result: 'no-match',
    });
  });
});
