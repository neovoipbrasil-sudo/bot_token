import { describe, it, expect, vi } from 'vitest';

const callMock = vi.fn().mockResolvedValue({ result: 123 });

vi.mock('../bitrix24/client.js', () => ({
  Bitrix24Client: vi.fn().mockImplementation(function () {
    this.portal = 'test.bitrix24.com.br';
    this.call = callMock;
  }),
}));

const { timelineAdd, timelinePin } = await import('./crm.js');

describe('timelineAdd', () => {
  it('sends the entity type lowercase, without the CRM_ prefix', async () => {
    await timelineAdd({ entity: 'lead', entity_id: 4292, comment: 'oi', webhook_url: 'https://test.bitrix24.com.br/rest/1/abc/' });

    expect(callMock).toHaveBeenCalledWith('crm.timeline.comment.add', {
      fields: { ENTITY_ID: 4292, ENTITY_TYPE: 'lead', COMMENT: 'oi' },
    });
  });
});

describe('timelinePin', () => {
  it('converts the entity code to the numeric ownerTypeId crm.timeline.item.pin expects', async () => {
    await timelinePin({ id: 999, entity: 'lead', entity_id: 4292, webhook_url: 'https://test.bitrix24.com.br/rest/1/abc/' });

    expect(callMock).toHaveBeenCalledWith('crm.timeline.item.pin', {
      id: 999,
      ownerTypeId: 1,
      ownerId: 4292,
    });
  });

  it('maps deal to ownerTypeId 2', async () => {
    await timelinePin({ id: 999, entity: 'deal', entity_id: 7028, webhook_url: 'https://test.bitrix24.com.br/rest/1/abc/' });

    expect(callMock).toHaveBeenCalledWith('crm.timeline.item.pin', {
      id: 999,
      ownerTypeId: 2,
      ownerId: 7028,
    });
  });

  it('throws for an entity type with no known ownerTypeId mapping', async () => {
    await expect(timelinePin({ id: 999, entity: 'quote', entity_id: 1 })).rejects.toThrow(/Entidad desconocida/);
  });
});
