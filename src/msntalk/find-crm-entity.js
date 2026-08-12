import { phoneVariants } from './normalize-phone.js';

// crm.deal.list / crm.lead.list silently drop every sibling AND condition
// (e.g. CLOSED, STATUS_SEMANTIC_ID) whenever filter.LOGIC = 'OR' appears
// anywhere in the payload, even nested — confirmed empirically against a
// live portal, where such a filter returned literally every open record
// instead of the intended intersection. So instead of asking the API to OR
// several conditions in one call, we issue one call per condition and merge
// the results ourselves (deduped by ID).
//
// A contact/empresa pode ter vários negócios (ou leads) abertos ao mesmo
// tempo — ex: um "TICKET" novo por atendimento, sem fechar os anteriores.
// Escolher só "o mais recente" deixava os demais permanentemente sem
// histórico de conversa; por isso retornamos TODOS os matches abertos e
// quem chama decide o que fazer com cada um.
async function collectMatches(client, method, filterClauses) {
  const byId = new Map();
  for (const filter of filterClauses) {
    const res = await client.call(method, { filter, select: ['ID'] });
    for (const item of res.result ?? []) byId.set(item.ID, item);
  }
  return [...byId.values()];
}

export async function findCrmEntity(client, phone) {
  const dupRes = await client.call('crm.duplicate.findbycomm', { type: 'PHONE', values: phoneVariants(phone) });
  const matches = dupRes.result ?? {};
  const contactIds = matches.CONTACT ?? [];
  const companyIds = matches.COMPANY ?? [];
  const leadIds = matches.LEAD ?? [];

  const dealFilters = [];
  if (contactIds.length > 0) dealFilters.push({ CLOSED: 'N', CONTACT_ID: contactIds });
  if (companyIds.length > 0) dealFilters.push({ CLOSED: 'N', COMPANY_ID: companyIds });
  if (dealFilters.length > 0) {
    const deals = await collectMatches(client, 'crm.deal.list', dealFilters);
    if (deals.length > 0) return { entity: 'deal', entity_ids: deals.map((d) => d.ID) };
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

  const leadFilters = [];
  if (leadIds.length > 0) leadFilters.push({ STATUS_SEMANTIC_ID: 'P', ID: leadIds });
  if (contactIds.length > 0) leadFilters.push({ STATUS_SEMANTIC_ID: 'P', CONTACT_ID: contactIds });
  if (contactCompanyIds.length > 0) leadFilters.push({ STATUS_SEMANTIC_ID: 'P', COMPANY_ID: contactCompanyIds });
  if (leadFilters.length > 0) {
    const leads = await collectMatches(client, 'crm.lead.list', leadFilters);
    if (leads.length > 0) return { entity: 'lead', entity_ids: leads.map((l) => l.ID) };
  }

  return null;
}
