import { describe, it, expect, vi } from 'vitest';
import { findCrmEntity } from './find-crm-entity.js';

function makeClient(responses) {
  return { call: vi.fn((method) => Promise.resolve(responses[method] ?? { result: [] })) };
}

describe('findCrmEntity', () => {
  it('returns the most recent open deal found via CONTACT_ID', async () => {
    const client = makeClient({
      'crm.duplicate.findbycomm': { result: { CONTACT: [10], LEAD: [] } },
      'crm.deal.list': { result: [{ ID: 555 }] },
    });

    const found = await findCrmEntity(client, '556121090177');

    expect(found).toEqual({ entity: 'deal', entity_id: 555 });
    expect(client.call).toHaveBeenCalledWith('crm.duplicate.findbycomm', { type: 'PHONE', values: ['556121090177'] });
    expect(client.call).toHaveBeenCalledWith('crm.deal.list', {
      filter: { CLOSED: 'N', CONTACT_ID: [10] },
      order: { DATE_CREATE: 'DESC' },
      select: ['ID'],
    });
  });

  it('returns an open deal found via COMPANY_ID when there is no matching contact', async () => {
    const client = makeClient({
      'crm.duplicate.findbycomm': { result: { COMPANY: [20], LEAD: [] } },
      'crm.deal.list': { result: [{ ID: 777 }] },
    });

    const found = await findCrmEntity(client, '556121090177');

    expect(found).toEqual({ entity: 'deal', entity_id: 777 });
    expect(client.call).toHaveBeenCalledWith('crm.deal.list', {
      filter: { CLOSED: 'N', COMPANY_ID: [20] },
      order: { DATE_CREATE: 'DESC' },
      select: ['ID'],
    });
  });

  it('combines CONTACT_ID and COMPANY_ID with OR logic when both match', async () => {
    const client = makeClient({
      'crm.duplicate.findbycomm': { result: { CONTACT: [10], COMPANY: [20], LEAD: [] } },
      'crm.deal.list': { result: [{ ID: 999 }] },
    });

    await findCrmEntity(client, '556121090177');

    expect(client.call).toHaveBeenCalledWith('crm.deal.list', {
      filter: { CLOSED: 'N', LOGIC: 'OR', 0: { CONTACT_ID: [10] }, 1: { COMPANY_ID: [20] } },
      order: { DATE_CREATE: 'DESC' },
      select: ['ID'],
    });
  });

  it('falls back to the most recent open lead when no deal is found', async () => {
    const client = makeClient({
      'crm.duplicate.findbycomm': { result: { CONTACT: [], LEAD: [30] } },
      'crm.lead.list': { result: [{ ID: 111 }] },
    });

    const found = await findCrmEntity(client, '556121090177');

    expect(found).toEqual({ entity: 'lead', entity_id: 111 });
    expect(client.call).toHaveBeenCalledWith('crm.lead.list', {
      filter: { ID: [30], STATUS_SEMANTIC_ID: 'P' },
      order: { DATE_CREATE: 'DESC' },
      select: ['ID'],
    });
  });

  it('falls back to a lead linked to the matched contact when the contact has no open deal', async () => {
    const client = makeClient({
      'crm.duplicate.findbycomm': { result: { CONTACT: [10], LEAD: [] } },
      'crm.deal.list': { result: [] },
      'crm.lead.list': { result: [{ ID: 222 }] },
    });

    const found = await findCrmEntity(client, '556121090177');

    expect(found).toEqual({ entity: 'lead', entity_id: 222 });
    expect(client.call).toHaveBeenCalledWith('crm.lead.list', {
      filter: { CONTACT_ID: [10], STATUS_SEMANTIC_ID: 'P' },
      order: { DATE_CREATE: 'DESC' },
      select: ['ID'],
    });
  });

  it('combines ID and CONTACT_ID with OR logic when both a direct lead and a contact-linked lead match', async () => {
    const client = makeClient({
      'crm.duplicate.findbycomm': { result: { CONTACT: [10], LEAD: [30] } },
      'crm.deal.list': { result: [] },
      'crm.lead.list': { result: [{ ID: 111 }] },
    });

    await findCrmEntity(client, '556121090177');

    expect(client.call).toHaveBeenCalledWith('crm.lead.list', {
      filter: { LOGIC: 'OR', 0: { ID: [30] }, 1: { CONTACT_ID: [10] }, STATUS_SEMANTIC_ID: 'P' },
      order: { DATE_CREATE: 'DESC' },
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

    expect(found).toEqual({ entity: 'lead', entity_id: 4290 });
    expect(client.call).toHaveBeenCalledWith('crm.contact.list', {
      filter: { ID: [8670] },
      select: ['ID', 'COMPANY_ID'],
    });
    expect(client.call).toHaveBeenCalledWith('crm.lead.list', {
      filter: { LOGIC: 'OR', 0: { CONTACT_ID: [8670] }, 1: { COMPANY_ID: [2184] }, STATUS_SEMANTIC_ID: 'P' },
      order: { DATE_CREATE: 'DESC' },
      select: ['ID'],
    });
  });

  it('returns null when nothing matches the phone at all', async () => {
    const client = makeClient({
      'crm.duplicate.findbycomm': { result: {} },
    });

    const found = await findCrmEntity(client, '556121090177');

    expect(found).toBeNull();
  });
});
