import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  crmListSchema, crmList,
  crmGetSchema, crmGet,
  crmCreateSchema, crmCreate,
  crmUpdateSchema, crmUpdate,
  crmDeleteSchema, crmDelete,
} from '../tools/crm.js';
import { tasksListSchema, tasksList, tasksCreateSchema, tasksCreate } from '../tools/tasks.js';
import { calendarListSchema, calendarList, calendarCreateSchema, calendarCreate } from '../tools/calendar.js';

export const TOOLS = [
  { name: 'crm_list', description: 'Lista registros de CRM (leads, deals, contacts, companies) com filtros opcionais. Ação de leitura, não exige confirmação.', schema: crmListSchema, handler: crmList, sensitive: false },
  { name: 'crm_get', description: 'Busca um único registro de CRM pelo ID. Ação de leitura, não exige confirmação.', schema: crmGetSchema, handler: crmGet, sensitive: false },
  { name: 'crm_create', description: 'Cria um novo registro de CRM (lead, deal, contact, company). Ação de escrita, exige confirmação do usuário antes de executar.', schema: crmCreateSchema, handler: crmCreate, sensitive: true },
  { name: 'crm_update', description: 'Atualiza campos de um registro de CRM existente, incluindo mudar de etapa/estágio. Ação de escrita, exige confirmação do usuário antes de executar.', schema: crmUpdateSchema, handler: crmUpdate, sensitive: true },
  { name: 'crm_delete', description: 'Exclui um registro de CRM. Ação de escrita irreversível, exige confirmação explícita do usuário antes de executar.', schema: crmDeleteSchema, handler: crmDelete, sensitive: true },
  { name: 'tasks_list', description: 'Lista tarefas do módulo de Tarefas do Bitrix24 com filtros opcionais. Ação de leitura, não exige confirmação.', schema: tasksListSchema, handler: tasksList, sensitive: false },
  { name: 'tasks_create', description: 'Cria uma nova tarefa. Ação de escrita, exige confirmação do usuário antes de executar.', schema: tasksCreateSchema, handler: tasksCreate, sensitive: true },
  { name: 'calendar_list', description: 'Lista eventos de calendário com filtros opcionais. Ação de leitura, não exige confirmação.', schema: calendarListSchema, handler: calendarList, sensitive: false },
  { name: 'calendar_create', description: 'Cria um novo evento de calendário. Ação de escrita, exige confirmação do usuário antes de executar.', schema: calendarCreateSchema, handler: calendarCreate, sensitive: true },
];

export function toolsForClaude() {
  return TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: zodToJsonSchema(t.schema, { target: 'openApi3', $refStrategy: 'none' }),
  }));
}

export function getTool(name) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool;
}
