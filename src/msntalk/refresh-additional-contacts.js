async function listAllIds(client, method, filter) {
  const ids = [];
  let start = 0;
  for (;;) {
    const res = await client.call(method, { filter, select: ['ID'], start });
    for (const item of res.result ?? []) ids.push(item.ID);
    if (!res.next) break;
    start = res.next;
  }
  return ids;
}

async function indexBindings(client, { listMethod, listFilter, itemsMethod, entity, addBinding }) {
  const ids = await listAllIds(client, listMethod, listFilter);
  for (const entityId of ids) {
    const res = await client.call(itemsMethod, { id: entityId });
    for (const item of res.result ?? []) addBinding(item.CONTACT_ID, entity, entityId);
  }
}

// Varre todo lead aberto (STATUS_SEMANTIC_ID='P') e negócio aberto
// (CLOSED='N') do portal chamando crm.lead.contact.items.get /
// crm.deal.contact.items.get um a um — não existe atalho em lote na API do
// Bitrix para isso. Em portais grandes são milhares de chamadas por ciclo;
// por isso `client` deve ser uma instância dedicada (não a usada para
// sincronizar mensagens em tempo real), para essa varredura não competir na
// fila de rate-limit com o webhook do MSN Talk.
export async function refreshAdditionalContacts({ client, index }) {
  const map = {};
  const addBinding = (contactId, entity, entityId) => {
    const list = map[contactId] ?? (map[contactId] = []);
    if (!list.some((e) => e.entity === entity && e.entity_id === entityId)) {
      list.push({ entity, entity_id: entityId });
    }
  };

  await indexBindings(client, {
    listMethod: 'crm.lead.list',
    listFilter: { STATUS_SEMANTIC_ID: 'P' },
    itemsMethod: 'crm.lead.contact.items.get',
    entity: 'lead',
    addBinding,
  });

  await indexBindings(client, {
    listMethod: 'crm.deal.list',
    listFilter: { CLOSED: 'N' },
    itemsMethod: 'crm.deal.contact.items.get',
    entity: 'deal',
    addBinding,
  });

  index.replaceAll(map);
  return map;
}
