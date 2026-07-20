import { describe, it, expect, vi, beforeEach } from 'vitest';

const findCrmEntityMock = vi.fn();
const timelineAddMock = vi.fn().mockResolvedValue({ success: true });

vi.mock('./find-crm-entity.js', () => ({ findCrmEntity: findCrmEntityMock }));
vi.mock('../tools/crm.js', () => ({ timelineAdd: timelineAddMock }));

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

describe('syncTimeline', () => {
  beforeEach(() => {
    findCrmEntityMock.mockClear();
    timelineAddMock.mockClear();
  });
  it('adds a timeline comment prefixed with "Cliente" for inbound messages', async () => {
    findCrmEntityMock.mockResolvedValueOnce({ entity: 'deal', entity_id: 555 });
    const client = {};
    const auditLog = { logAction: vi.fn() };

    const result = await syncTimeline({ event: baseEvent(), client, auditLog });

    expect(result).toEqual({ matched: true, entity: 'deal', entity_id: 555 });
    expect(timelineAddMock).toHaveBeenCalledWith({
      entity: 'deal',
      entity_id: 555,
      comment: '[MSN Talk] Cliente: Bom dia',
    });
    expect(auditLog.logAction).not.toHaveBeenCalled();
  });

  it('adds a timeline comment prefixed with "SDR" for outbound messages', async () => {
    findCrmEntityMock.mockResolvedValueOnce({ entity: 'lead', entity_id: 111 });
    const client = {};
    const auditLog = { logAction: vi.fn() };

    await syncTimeline({ event: baseEvent({ direction: 'outbound', text: 'Já te respondo' }), client, auditLog });

    expect(timelineAddMock).toHaveBeenCalledWith({
      entity: 'lead',
      entity_id: 111,
      comment: '[MSN Talk] SDR: Já te respondo',
    });
  });

  it('appends the resolved ticket link when a template is provided', async () => {
    findCrmEntityMock.mockResolvedValueOnce({ entity: 'deal', entity_id: 555 });
    const client = {};
    const auditLog = { logAction: vi.fn() };

    await syncTimeline({
      event: baseEvent(),
      client,
      auditLog,
      ticketUrlTemplate: 'https://app.msntalk.neovoip.com.br/atendimento?ticketId={ticketId}',
    });

    expect(timelineAddMock).toHaveBeenCalledWith({
      entity: 'deal',
      entity_id: 555,
      comment: '[MSN Talk] Cliente: Bom dia\nhttps://app.msntalk.neovoip.com.br/atendimento?ticketId=92315',
    });
  });

  it('logs to the audit log and skips timelineAdd when no CRM entity matches', async () => {
    findCrmEntityMock.mockResolvedValueOnce(null);
    const client = {};
    const auditLog = { logAction: vi.fn() };

    const result = await syncTimeline({ event: baseEvent(), client, auditLog });

    expect(result).toEqual({ matched: false });
    expect(timelineAddMock).not.toHaveBeenCalled();
    expect(auditLog.logAction).toHaveBeenCalledWith({
      tool: 'msntalk-sync',
      params: { phone: '556121090177', ticketId: 92315 },
      result: 'no-match',
    });
  });
});
