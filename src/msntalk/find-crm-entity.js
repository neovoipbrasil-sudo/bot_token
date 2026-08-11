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

  // The phone may belong to a Contact who isn't the one wired to the Lead
  // (e.g. a colleague at the same company messaging in) — the Lead itself
  // has no PHONE of its own, so findbycomm never surfaces it directly, but
  // it can still be reached via COMPANY_ID.
  let contactCompanyIds = [];
  if (contactIds.length > 0) {
    const contactRes = await client.call('crm.contact.list', {
      filter: { ID: contactIds },
      select: ['ID', 'COMPANY_ID'],
    });
    contactCompanyIds = [...new Set((contactRes.result ?? []).map(c => c.COMPANY_ID).filter(Boolean))];
  }

  if (leadIds.length > 0 || contactIds.length > 0 || contactCompanyIds.length > 0) {
    const filter = { STATUS_SEMANTIC_ID: 'P' };
    const orClauses = [];
    if (leadIds.length > 0) orClauses.push({ ID: leadIds });
    if (contactIds.length > 0) orClauses.push({ CONTACT_ID: contactIds });
    if (contactCompanyIds.length > 0) orClauses.push({ COMPANY_ID: contactCompanyIds });

    if (orClauses.length > 1) {
      filter.LOGIC = 'OR';
      orClauses.forEach((clause, i) => { filter[i] = clause; });
    } else {
      Object.assign(filter, orClauses[0]);
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
