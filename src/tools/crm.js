import { z } from 'zod';
import { Bitrix24Client } from '../bitrix24/client.js';
import { fetchAllPages } from '../utils/pagination.js';
import { resolveWebhook } from '../utils/resolve-webhook.js';

// Mapa de entidad a método base de la REST API
const ENTITY_METHOD = {
  deal:     'crm.deal',
  contact:  'crm.contact',
  company:  'crm.company',
  lead:     'crm.lead',
  quote:    'crm.quote',
  invoice:  'crm.invoice',
  order:    'sale.order',
  // SPA / Smart Process usa crm.item con entityTypeId
};

function resolveMethod(entity, entityTypeId) {
  if (entityTypeId) return { base: 'crm.item', extra: { entityTypeId } };
  const base = ENTITY_METHOD[entity?.toLowerCase()];
  if (!base) throw new Error(`Entidad desconocida: "${entity}". Usá deal, contact, company, lead, quote, invoice, o pasá entityTypeId para SPA.`);
  return { base, extra: {} };
}

// ─── LIST ─────────────────────────────────────────────────────────────────────

export const crmListSchema = z.object({
  entity: z.string().optional().describe('Tipo de entidad: deal, contact, company, lead, quote, invoice'),
  entity_type_id: z.number().int().optional().describe('ID de SPA (Smart Process). Alternativa a entity para procesos personalizados'),
  filter: z.record(z.any()).optional().default({}).describe('Filtros. Ejemplo: { "STAGE_ID": "WON", ">DATE_CREATE": "2026-01-01" }'),
  select: z.array(z.string()).optional().describe('Campos a retornar. Ejemplo: ["ID","TITLE","STAGE_ID","ASSIGNED_BY_ID"]'),
  order: z.record(z.string()).optional().describe('Ordenamiento. Ejemplo: { "DATE_CREATE": "DESC" }'),
  all_pages: z.boolean().optional().default(false).describe('Si true, trae todos los registros paginando automáticamente'),
  webhook_url: z.string().url().optional(),
});

export async function crmList({ entity, entity_type_id, filter = {}, select, order, all_pages = false, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const { base, extra } = resolveMethod(entity, entity_type_id);
  const params = { filter, ...extra, ...(select ? { select } : {}), ...(order ? { order } : {}) };

  let items;
  if (all_pages) {
    items = await fetchAllPages(client, `${base}.list`, params);
  } else {
    const res = await client.call(`${base}.list`, params);
    items = res.result?.items ?? res.result ?? [];
  }

  return { entity: entity || `SPA_${entity_type_id}`, portal: client.portal, count: items.length, items };
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export const crmGetSchema = z.object({
  entity: z.string().optional(),
  entity_type_id: z.number().int().optional(),
  id: z.union([z.string(), z.number()]).describe('ID del registro'),
  webhook_url: z.string().url().optional(),
});

export async function crmGet({ entity, entity_type_id, id, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const { base, extra } = resolveMethod(entity, entity_type_id);
  const res = await client.call(`${base}.get`, { id, ...extra });
  return { entity: entity || `SPA_${entity_type_id}`, portal: client.portal, item: res.result?.item ?? res.result };
}

// ─── CREATE ───────────────────────────────────────────────────────────────────

export const crmCreateSchema = z.object({
  entity: z.string().optional(),
  entity_type_id: z.number().int().optional(),
  fields: z.record(z.any()).describe('Campos del registro a crear. Ejemplo: { "TITLE": "Nuevo deal", "STAGE_ID": "NEW", "ASSIGNED_BY_ID": 1 }'),
  params: z.record(z.any()).optional().describe('Parámetros adicionales del método (ej: REGISTER_SONET_EVENT)'),
  webhook_url: z.string().url().optional(),
});

export async function crmCreate({ entity, entity_type_id, fields, params = {}, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const { base, extra } = resolveMethod(entity, entity_type_id);
  const res = await client.call(`${base}.add`, { fields: { ...fields, ...extra }, params });
  const id = res.result?.item?.id ?? res.result;
  return { entity: entity || `SPA_${entity_type_id}`, portal: client.portal, created_id: id };
}

// ─── UPDATE ───────────────────────────────────────────────────────────────────

export const crmUpdateSchema = z.object({
  entity: z.string().optional(),
  entity_type_id: z.number().int().optional(),
  id: z.union([z.string(), z.number()]),
  fields: z.record(z.any()).describe('Campos a actualizar'),
  params: z.record(z.any()).optional(),
  webhook_url: z.string().url().optional(),
});

export async function crmUpdate({ entity, entity_type_id, id, fields, params = {}, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const { base, extra } = resolveMethod(entity, entity_type_id);
  await client.call(`${base}.update`, { id, fields, params, ...extra });
  return { entity: entity || `SPA_${entity_type_id}`, portal: client.portal, updated_id: id, success: true };
}

// ─── DELETE ───────────────────────────────────────────────────────────────────

export const crmDeleteSchema = z.object({
  entity: z.string().optional(),
  entity_type_id: z.number().int().optional(),
  id: z.union([z.string(), z.number()]),
  webhook_url: z.string().url().optional(),
});

export async function crmDelete({ entity, entity_type_id, id, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const { base, extra } = resolveMethod(entity, entity_type_id);
  await client.call(`${base}.delete`, { id, ...extra });
  return { entity: entity || `SPA_${entity_type_id}`, portal: client.portal, deleted_id: id, success: true };
}

// ─── FIELDS ───────────────────────────────────────────────────────────────────

export const crmFieldsSchema = z.object({
  entity: z.string().optional().describe('Tipo de entidad: deal, contact, company, lead'),
  entity_type_id: z.number().int().optional().describe('ID de SPA'),
  webhook_url: z.string().url().optional(),
});

export async function crmFields({ entity, entity_type_id, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const { base, extra } = resolveMethod(entity, entity_type_id);
  const res = await client.call(`${base}.fields`, extra);
  const fields = res.result?.fields ?? res.result ?? {};
  const fieldList = Object.entries(fields).map(([code, def]) => ({ code, ...def }));
  return {
    entity: entity || `SPA_${entity_type_id}`,
    portal: client.portal,
    total_fields: fieldList.length,
    fields: fieldList,
  };
}

// ─── TIMELINE ─────────────────────────────────────────────────────────────────

export const timelineAddSchema = z.object({
  entity: z.string().describe('Tipo de entidad CRM: deal, contact, company, lead'),
  entity_id: z.union([z.string(), z.number()]).describe('ID del registro CRM'),
  comment: z.string().describe('Texto del comentario a agregar en la línea de tiempo'),
  webhook_url: z.string().url().optional(),
});

export async function timelineAdd({ entity, entity_id, comment, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  // crm.timeline.comment.add quer o código de entidade minúsculo (lead, deal,
  // contact, company) — o prefixo CRM_ usado noutros métodos causa OWNER_NOT_FOUND aquí.
  const res = await client.call('crm.timeline.comment.add', {
    fields: { ENTITY_ID: entity_id, ENTITY_TYPE: entity.toLowerCase(), COMMENT: comment },
  });
  return { portal: client.portal, entity, entity_id, comment_id: res.result, success: true };
}

export const timelineCommentUpdateSchema = z.object({
  id: z.union([z.string(), z.number()]).describe('ID del comentario devuelto por timelineAdd'),
  comment: z.string(),
  webhook_url: z.string().url().optional(),
});

export async function timelineCommentUpdate({ id, comment, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  await client.call('crm.timeline.comment.update', { id, fields: { COMMENT: comment } });
  return { portal: client.portal, id, success: true };
}
