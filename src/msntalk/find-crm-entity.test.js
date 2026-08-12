import { describe, it, expect, vi } from 'vitest';
import { findCrmEntity } from './find-crm-entity.js';

function makeClient(responses) {
  return { call: vi.fn((method) => Promise.resolve(responses[method] ?? { result: [] })) };
}

describe('findCrmEntity', () => {
  it('returns the open deal found via CONTACT_ID', async () => {
    const client = makeClient({
      'crm.duplicate.findbycomm': { result: { CONTACT: [10], LEAD: [] } },
      'crm.deal.list': { result: [{ ID: 555 }] },
    });

    const found = await findCrmEntity(client, '556121090177');

    expect(found).toEqual({ entity: 'deal', entity_ids: [555] });
    expect(client.call).toHaveBeenCalledWith('crm.duplicate.findbycomm', { type: 'PHONE', values: ['556121090177'] });
    expect(client.call).toHaveBeenCalledWith('crm.deal.list', {
      filter: { CLOSED: 'N', CONTACT_ID: [10] },
      select: ['ID'],
    });
  });

  it('returns an open deal found via COMPANY_ID when there is no matching contact', async () => {
    const client = makeClient({
      'crm.duplicate.findbycomm': { result: { COMPANY: [20], LEAD: [] } },
      'crm.deal.list': { result: [{ ID: 777 }] },
    });

    const found = await findCrmEntity(client, '556121090177');

    expect(found).toEqual({ entity: 'deal', entity_ids: [777] });
    expect(client.call).toHaveBeenCalledWith('crm.deal.list', {
      filter: { CLOSED: 'N', COMPANY_ID: [20] },
      select: ['ID'],
    });
  });

  it('returns every open deal when CONTACT_ID and COMPANY_ID match different deals, deduped by ID', async () => {
    const client = {
      call: vi.fn((method, params) => {
        if (method === 'crm.duplicate.findbycomm') return Promise.resolve({ result: { CONTACT: [10], COMPANY: [20], LEAD: [] } });
        if (method === 'crm.deal.list' && params.filter.CONTACT_ID) {
          return Promise.resolve({ result: [{ ID: 111 }, { ID: 999 }] });
        }
        if (method === 'crm.deal.list' && params.filter.COMPANY_ID) {
          return Promise.resolve({ result: [{ ID: 999 }] }); // 999 matches both — must not be duplicated
        }
        return Promise.resolve({ result: [] });
      }),
    };

    const found = await findCrmEntity(client, '556121090177');

    expect(found).toEqual({ entity: 'deal', entity_ids: [111, 999] });
    expect(client.call).toHaveBeenCalledWith('crm.deal.list', {
      filter: { CLOSED: 'N', CONTACT_ID: [10] },
      select: ['ID'],
    });
    expect(client.call).toHaveBeenCalledWith('crm.deal.list', {
      filter: { CLOSED: 'N', COMPANY_ID: [20] },
      select: ['ID'],
    });
  });

  it('falls back to every open lead when no deal is found', async () => {
    const client = makeClient({
      'crm.duplicate.findbycomm': { result: { CONTACT: [], LEAD: [30] } },
      'crm.lead.list': { result: [{ ID: 111 }] },
    });

    const found = await findCrmEntity(client, '556121090177');

    expect(found).toEqual({ entity: 'lead', entity_ids: [111] });
    expect(client.call).toHaveBeenCalledWith('crm.lead.list', {
      filter: { STATUS_SEMANTIC_ID: 'P', ID: [30] },
      select: ['ID'],
    });
  });

  it('falls back to a lead linked to the matched contact when the contact has no open deal', async () => {
    const client = makeClient({
      'crm.duplicate.findbycomm': { result: { CONTACT: [10], LEAD: [] } },
      'crm.deal.list': { result: [] },
      'crm.contact.list': { result: [] },
      'crm.lead.list': { result: [{ ID: 222 }] },
    });

    const found = await findCrmEntity(client, '556121090177');

    expect(found).toEqual({ entity: 'lead', entity_ids: [222] });
    expect(client.call).toHaveBeenCalledWith('crm.lead.list', {
      filter: { STATUS_SEMANTIC_ID: 'P', CONTACT_ID: [10] },
      select: ['ID'],
    });
  });

  it('falls back to a lead linked to the matched contact\'s company when the contact itself is not wired to any lead', async () => {
    const client = makeClient({
      'crm.duplicate.findbycomm': { result: { CONTACT: [8670], LEAD: [] } },
      'crm.deal.list': { result: [] },
      'crm.contact.list': { result: [{ ID: 8670, COMPANY_ID: 2184 }] },
      'crm.lead.list': { result: [{ ID: 4290 }] },
    });

    const found = await findCrmEntity(client, '5521974392638');

    expect(found).toEqual({ entity: 'lead', entity_ids: [4290] });
    expect(client.call).toHaveBeenCalledWith('crm.contact.list', {
      filter: { ID: [8670] },
      select: ['ID', 'COMPANY_ID'],
    });
    expect(client.call).toHaveBeenCalledWith('crm.lead.list', {
      filter: { STATUS_SEMANTIC_ID: 'P', CONTACT_ID: [8670] },
      select: ['ID'],
    });
    expect(client.call).toHaveBeenCalledWith('crm.lead.list', {
      filter: { STATUS_SEMANTIC_ID: 'P', COMPANY_ID: [2184] },
      select: ['ID'],
    });
  });

  it('returns every matching open lead when a direct LEAD match and a contact-linked lead differ', async () => {
    const client = {
      call: vi.fn((method, params) => {
        if (method === 'crm.duplicate.findbycomm') return Promise.resolve({ result: { CONTACT: [10], LEAD: [30] } });
        if (method === 'crm.deal.list') return Promise.resolve({ result: [] });
        if (method === 'crm.contact.list') return Promise.resolve({ result: [] });
        if (method === 'crm.lead.list' && params.filter.ID) {
          return Promise.resolve({ result: [{ ID: 30 }] });
        }
        if (method === 'crm.lead.list' && params.filter.CONTACT_ID) {
          return Promise.resolve({ result: [{ ID: 111 }] });
        }
        return Promise.resolve({ result: [] });
      }),
    };

    const found = await findCrmEntity(client, '556121090177');

    expect(found).toEqual({ entity: 'lead', entity_ids: [30, 111] });
  });

  it('returns null when nothing matches the phone at all', async () => {
    const client = makeClient({
      'crm.duplicate.findbycomm': { result: {} },
    });

    const found = await findCrmEntity(client, '556121090177');

    expect(found).toBeNull();
  });
});
