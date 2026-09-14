import { describe, it, expect, vi } from 'vitest';
import { refreshAdditionalContacts } from './refresh-additional-contacts.js';

function makeIndex() {
  return { replaceAll: vi.fn() };
}

describe('refreshAdditionalContacts', () => {
  it('indexes every contact bound to an open lead or deal, keyed by contact id', async () => {
    const client = {
      call: vi.fn((method, params) => {
        if (method === 'crm.lead.list') return Promise.resolve({ result: [{ ID: 4400 }] });
        if (method === 'crm.deal.list') return Promise.resolve({ result: [{ ID: 8876 }] });
        if (method === 'crm.lead.contact.items.get' && params.id === 4400) {
          return Promise.resolve({ result: [{ CONTACT_ID: 8884, IS_PRIMARY: 'Y' }, { CONTACT_ID: 9062, IS_PRIMARY: 'N' }] });
        }
        if (method === 'crm.deal.contact.items.get' && params.id === 8876) {
          return Promise.resolve({ result: [{ CONTACT_ID: 111, IS_PRIMARY: 'Y' }] });
        }
        return Promise.resolve({ result: [] });
      }),
    };
    const index = makeIndex();

    const map = await refreshAdditionalContacts({ client, index });

    expect(map).toEqual({
      8884: [{ entity: 'lead', entity_id: 4400 }],
      9062: [{ entity: 'lead', entity_id: 4400 }],
      111: [{ entity: 'deal', entity_id: 8876 }],
    });
    expect(index.replaceAll).toHaveBeenCalledWith(map);
  });

  it('follows pagination via the "next" cursor when listing leads/deals', async () => {
    const client = {
      call: vi.fn((method, params) => {
        if (method === 'crm.lead.list' && params.start === 0) {
          return Promise.resolve({ result: [{ ID: 1 }], next: 50 });
        }
        if (method === 'crm.lead.list' && params.start === 50) {
          return Promise.resolve({ result: [{ ID: 2 }] });
        }
        if (method === 'crm.lead.contact.items.get') {
          return Promise.resolve({ result: [{ CONTACT_ID: 10 + params.id }] });
        }
        return Promise.resolve({ result: [] });
      }),
    };
    const index = makeIndex();

    const map = await refreshAdditionalContacts({ client, index });

    expect(map).toEqual({
      11: [{ entity: 'lead', entity_id: 1 }],
      12: [{ entity: 'lead', entity_id: 2 }],
    });
  });

  it('dedupes a contact bound to the same lead more than once', async () => {
    const client = {
      call: vi.fn((method, params) => {
        if (method === 'crm.lead.list') return Promise.resolve({ result: [{ ID: 4400 }] });
        if (method === 'crm.deal.list') return Promise.resolve({ result: [] });
        if (method === 'crm.lead.contact.items.get') {
          return Promise.resolve({ result: [{ CONTACT_ID: 9062 }, { CONTACT_ID: 9062 }] });
        }
        return Promise.resolve({ result: [] });
      }),
    };
    const index = makeIndex();

    const map = await refreshAdditionalContacts({ client, index });

    expect(map).toEqual({ 9062: [{ entity: 'lead', entity_id: 4400 }] });
  });

  it('produces an empty map when there are no open leads or deals', async () => {
    const client = { call: vi.fn(() => Promise.resolve({ result: [] })) };
    const index = makeIndex();

    const map = await refreshAdditionalContacts({ client, index });

    expect(map).toEqual({});
    expect(index.replaceAll).toHaveBeenCalledWith({});
  });
});
