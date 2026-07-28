import { phoneVariants } from './normalize-phone.js';

export async function findCrmEntity(client, phone) {
  const dupRes = await client.call('crm.duplicate.findbycomm', { type: 'PHONE', values: phoneVariants(phone) });
  const matches = dupRes.result ?? {};
  const contactIds = matches.CONTACT ?? [];
  const companyIds = matches.COMPANY ?? [];
  const leadIds = matches.LEAD ?? [];

  if (contactIds.length > 0 || companyIds.length > 0) {
    const filter = { CLOSED: 'N' };
    if (contactIds.length > 0 && companyIds.length > 0) {
      filter.LOGIC = 'OR';
      filter[0] = { CONTACT_ID: contactIds };
      filter[1] = { COMPANY_ID: companyIds };
    } else if (contactIds.length > 0) {
      filter.CONTACT_ID = contactIds;
    } else {
      filter.COMPANY_ID = companyIds;
    }

    const dealRes = await client.call('crm.deal.list', {
      filter,
      order: { DATE_CREATE: 'DESC' },
      select: ['ID'],
    });
    const deals = dealRes.result ?? [];
    if (deals.length > 0) {
      return { entity: 'deal', entity_id: deals[0].ID };
    }
  }

  if (leadIds.length > 0 || contactIds.length > 0) {
    const filter = { STATUS_SEMANTIC_ID: 'P' };
    if (leadIds.length > 0 && contactIds.length > 0) {
      filter.LOGIC = 'OR';
      filter[0] = { ID: leadIds };
      filter[1] = { CONTACT_ID: contactIds };
    } else if (leadIds.length > 0) {
      filter.ID = leadIds;
    } else {
      // The phone matched a Contact but not a Deal — the Contact may still be
      // linked to an open Lead (Lead.CONTACT_ID) even though the Lead itself
      // has no PHONE of its own, so findbycomm never surfaced it directly.
      filter.CONTACT_ID = contactIds;
    }

    const leadRes = await client.call('crm.lead.list', {
      filter,
      order: { DATE_CREATE: 'DESC' },
      select: ['ID'],
    });
    const leads = leadRes.result ?? [];
    if (leads.length > 0) {
      return { entity: 'lead', entity_id: leads[0].ID };
    }
  }

  return null;
}
