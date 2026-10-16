import { describe, it, expect, vi, beforeEach } from 'vitest';

const findCrmEntityMock = vi.fn();
const timelineAddMock = vi.fn().mockResolvedValue({ comment_id: 297878, success: true });
const timelineCommentUpdateMock = vi.fn().mockResolvedValue({ success: true });
const timelinePinMock = vi.fn().mockResolvedValue({ success: true });
const crmUpdateMock = vi.fn().mockResolvedValue({ success: true });
const crmCreateMock = vi.fn();

vi.mock('./find-crm-entity.js', () => ({ findCrmEntity: findCrmEntityMock }));
vi.mock('../tools/crm.js', () => ({
  timelineAdd: timelineAddMock,
  timelineCommentUpdate: timelineCommentUpdateMock,
  timelinePin: timelinePinMock,
  crmUpdate: crmUpdateMock,
  crmCreate: crmCreateMock,
}));

const { reconcilePending } = await import('./reconcile-pending.js');

function makePendingStore(entries) {
  const data = { ...entries };
  return {
    listPhones: vi.fn(() => Object.keys(data)),
    takePending: vi.fn((phone) => {
      const pending = data[phone] ?? { ticketId: null, lines: [] };
      delete data[phone];
      return pending;
    }),
  };
}

function makeThreadStore(initial = {}) {
  const data = { ...initial };
  return {
    getThread: vi.fn((ticketId) => data[ticketId] ?? null),
    saveThread: vi.fn((ticketId, thread) => { data[ticketId] = thread; }),
  };
}

describe('reconcilePending', () => {
  beforeEach(() => {
    findCrmEntityMock.mockClear();
    timelineAddMock.mockClear();
    timelineCommentUpdateMock.mockClear();
    timelinePinMock.mockClear();
    crmUpdateMock.mockClear();
  });

  it('posts a pending phone\'s lines to the timeline once it matches a CRM entity', async () => {
    findCrmEntityMock.mockResolvedValueOnce([{ entity: 'lead', entity_ids: [4400] }]);
    const pendingStore = makePendingStore({
      '5591984215280': { ticketId: 106389, lines: ['[08/09 18:02] Augusto: Boa tarde', '[14/09 15:06] SDR: Entendi'] },
    });
    const threadStore = makeThreadStore();
    const auditLog = { logAction: vi.fn() };

    const result = await reconcilePending({ client: {}, pendingStore, threadStore, auditLog });

    expect(result).toEqual({ reconciled: 1 });
    expect(timelineAddMock).toHaveBeenCalledWith({
      entity: 'lead',
      entity_id: 4400,
      comment: [
        '[MSN Talk] Ticket #106389',
        '',
        '[08/09 18:02] Augusto: Boa tarde',
        '[14/09 15:06] SDR: Entendi',
      ].join('\n'),
    });
    expect(timelinePinMock).toHaveBeenCalledWith({ id: 297878, entity: 'lead', entity_id: 4400 });
    expect(threadStore.saveThread).toHaveBeenCalledWith(106389, {
      comments: { 'lead:4400': 297878 },
      lines: ['[08/09 18:02] Augusto: Boa tarde', '[14/09 15:06] SDR: Entendi'],
    });
    expect(auditLog.logAction).toHaveBeenCalledWith({
      tool: 'msntalk-sync',
      params: { phone: '5591984215280', ticketId: 106389, entity_id: 4400, recovered: 2 },
      result: 'backfill',
    });
  });

  it('leaves a phone pending when findCrmEntity still finds nothing for it', async () => {
    findCrmEntityMock.mockResolvedValueOnce(null);
    const pendingStore = makePendingStore({
      '5511999999999': { ticketId: 100, lines: ['Cliente: oi'] },
    });
    const threadStore = makeThreadStore();
    const auditLog = { logAction: vi.fn() };

    const result = await reconcilePending({ client: {}, pendingStore, threadStore, auditLog });

    expect(result).toEqual({ reconciled: 0 });
    expect(pendingStore.takePending).not.toHaveBeenCalled();
    expect(timelineAddMock).not.toHaveBeenCalled();
  });

  it('checks every pending phone independently, reconciling only the ones that now match', async () => {
    findCrmEntityMock
      .mockResolvedValueOnce(null) // primeiro telefone continua sem match
      .mockResolvedValueOnce([{ entity: 'deal', entity_ids: [11000] }]); // segundo já bate
    const pendingStore = makePendingStore({
      '5511999999999': { ticketId: 100, lines: ['Cliente: oi'] },
      '556199351441': { ticketId: 105356, lines: ['Sabrina: boa tarde'] },
    });
    const threadStore = makeThreadStore();
    const auditLog = { logAction: vi.fn() };

    const result = await reconcilePending({ client: {}, pendingStore, threadStore, auditLog });

    expect(result).toEqual({ reconciled: 1 });
    expect(timelineAddMock).toHaveBeenCalledWith(expect.objectContaining({ entity: 'deal', entity_id: 11000 }));
  });

  it('uses a non-numeric fallback ticketId for legacy pending entries with no ticketId recorded', async () => {
    findCrmEntityMock.mockResolvedValueOnce([{ entity: 'deal', entity_ids: [10122] }]);
    const pendingStore = makePendingStore({
      '556336026113': { ticketId: null, lines: ['Cliente: oi, antes de guardarmos o ticketId'] },
    });
    const threadStore = makeThreadStore();
    const auditLog = { logAction: vi.fn() };

    await reconcilePending({ client: {}, pendingStore, threadStore, auditLog });

    expect(timelineAddMock).toHaveBeenCalledWith(expect.objectContaining({
      comment: expect.stringContaining('Ticket #legado'),
    }));
    expect(threadStore.saveThread).toHaveBeenCalledWith('legado', expect.anything());
  });

  it('merges with lines already synced for the same ticket, if any', async () => {
    findCrmEntityMock.mockResolvedValueOnce([{ entity: 'lead', entity_ids: [4400] }]);
    const pendingStore = makePendingStore({
      '5591984215280': { ticketId: 106389, lines: ['[14/09 15:06] SDR: mensagem pendente'] },
    });
    const threadStore = makeThreadStore({
      106389: { comments: { 'lead:4400': 999 }, lines: ['[01/09 10:00] Cliente: já sincronizado antes'] },
    });
    const auditLog = { logAction: vi.fn() };

    await reconcilePending({ client: {}, pendingStore, threadStore, auditLog });

    expect(timelineCommentUpdateMock).toHaveBeenCalledWith({
      id: 999,
      comment: expect.stringContaining('[01/09 10:00] Cliente: já sincronizado antes'),
    });
  });
});
