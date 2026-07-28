import { describe, it, expect, vi } from 'vitest';

const callMock = vi.fn().mockResolvedValue({ result: 123 });

vi.mock('../bitrix24/client.js', () => ({
  Bitrix24Client: vi.fn().mockImplementation(function () {
    this.portal = 'test.bitrix24.com.br';
    this.call = callMock;
  }),
}));

const { timelineAdd } = await import('./crm.js');

describe('timelineAdd', () => {
  it('sends the entity type lowercase, without the CRM_ prefix', async () => {
    await timelineAdd({ entity: 'lead', entity_id: 4292, comment: 'oi', webhook_url: 'https://test.bitrix24.com.br/rest/1/abc/' });

    expect(callMock).toHaveBeenCalledWith('crm.timeline.comment.add', {
      fields: { ENTITY_ID: 4292, ENTITY_TYPE: 'lead', COMMENT: 'oi' },
    });
  });
});
