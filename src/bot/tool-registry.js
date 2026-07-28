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
import { usersListSchema, usersList, departmentsListSchema, departmentsList } from '../tools/users-departments.js';
import {
  diskStoragesSchema, diskStorages,
  diskFolderListSchema, diskFolderList,
  diskFileGetSchema, diskFileGet,
  diskFileUploadSchema, diskFileUpload,
} from '../tools/disk.js';
import {
  feedPostSchema, feedPost,
  notifySendSchema, notifySend,
  groupsListSchema, groupsList,
  chatSendSchema, chatSend,
  bizprocListSchema, bizprocList,
  bizprocStartSchema, bizprocStart,
  telephonyCallsSchema, telephonyCalls,
} from '../tools/feed-notifications.js';
import {
  productsListSchema, productsList,
  productsGetSchema, productsGet,
  productsCreateSchema, productsCreate,
  productsUpdateSchema, productsUpdate,
  productsSectionsSchema, productsSections,
} from '../tools/catalog-products.js';
import { readPipelinesSchema, readPipelines } from '../tools/read-pipelines.js';
import { readCustomFieldsSchema, readCustomFields } from '../tools/read-custom-fields.js';

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

  { name: 'users_list', description: 'Lista usuários do portal Bitrix24 (nome, ID, cargo, departamento, email) com filtros opcionais. Use para identificar o ID de uma pessoa pelo nome ou vice-versa. Ação de leitura, não exige confirmação.', schema: usersListSchema, handler: usersList, sensitive: false },
  { name: 'departments_list', description: 'Lista os departamentos do portal Bitrix24. Ação de leitura, não exige confirmação.', schema: departmentsListSchema, handler: departmentsList, sensitive: false },

  { name: 'disk_storages', description: 'Lista os storages de disco disponíveis no portal. Ação de leitura, não exige confirmação.', schema: diskStoragesSchema, handler: diskStorages, sensitive: false },
  { name: 'disk_folder_list', description: 'Lista arquivos e subpastas dentro de uma pasta do Disco. Ação de leitura, não exige confirmação.', schema: diskFolderListSchema, handler: diskFolderList, sensitive: false },
  { name: 'disk_file_get', description: 'Busca metadados e link de download de um arquivo do Disco pelo ID. Ação de leitura, não exige confirmação.', schema: diskFileGetSchema, handler: diskFileGet, sensitive: false },
  { name: 'disk_file_upload', description: 'Envia um novo arquivo (conteúdo em base64) para uma pasta do Disco. Ação de escrita, exige confirmação do usuário antes de executar.', schema: diskFileUploadSchema, handler: diskFileUpload, sensitive: true },

  { name: 'groups_list', description: 'Lista os grupos de trabalho (workgroups) do portal. Ação de leitura, não exige confirmação.', schema: groupsListSchema, handler: groupsList, sensitive: false },
  { name: 'bizproc_list', description: 'Lista os processos de negócio (automações) em execução para um registro. Ação de leitura, não exige confirmação.', schema: bizprocListSchema, handler: bizprocList, sensitive: false },
  { name: 'telephony_calls', description: 'Lista o histórico de chamadas de telefonia com filtros opcionais. Ação de leitura, não exige confirmação.', schema: telephonyCallsSchema, handler: telephonyCalls, sensitive: false },
  { name: 'feed_post', description: 'Publica uma postagem no Feed (mural de notícias) da empresa, visível a outros usuários. Ação de escrita, exige confirmação do usuário antes de executar.', schema: feedPostSchema, handler: feedPost, sensitive: true },
  { name: 'notify_send', description: 'Envia uma notificação do sistema para um usuário do portal. Ação de escrita que afeta outra pessoa, exige confirmação do usuário antes de executar.', schema: notifySendSchema, handler: notifySend, sensitive: true },
  { name: 'chat_send', description: 'Envia uma mensagem de chat para um diálogo do Bitrix24 em nome do bot. Ação de escrita que afeta outra pessoa, exige confirmação do usuário antes de executar.', schema: chatSendSchema, handler: chatSend, sensitive: true },
  { name: 'bizproc_start', description: 'Inicia um processo de negócio (automação) em um registro. Ação de escrita com efeitos colaterais reais, exige confirmação do usuário antes de executar.', schema: bizprocStartSchema, handler: bizprocStart, sensitive: true },

  { name: 'products_list', description: 'Lista produtos do catálogo com filtros opcionais. Ação de leitura, não exige confirmação.', schema: productsListSchema, handler: productsList, sensitive: false },
  { name: 'products_get', description: 'Busca um produto do catálogo pelo ID. Ação de leitura, não exige confirmação.', schema: productsGetSchema, handler: productsGet, sensitive: false },
  { name: 'products_sections', description: 'Lista as seções (categorias) de um catálogo de produtos. Ação de leitura, não exige confirmação.', schema: productsSectionsSchema, handler: productsSections, sensitive: false },
  { name: 'products_create', description: 'Cria um novo produto no catálogo. Ação de escrita, exige confirmação do usuário antes de executar.', schema: productsCreateSchema, handler: productsCreate, sensitive: true },
  { name: 'products_update', description: 'Atualiza campos de um produto existente do catálogo. Ação de escrita, exige confirmação do usuário antes de executar.', schema: productsUpdateSchema, handler: productsUpdate, sensitive: true },

  { name: 'read_pipelines', description: 'Lista os funis (pipelines) e estágios configurados para um tipo de entidade de CRM. Ação de leitura, não exige confirmação.', schema: readPipelinesSchema, handler: readPipelines, sensitive: false },
  { name: 'read_custom_fields', description: 'Lista os campos personalizados configurados para um tipo de entidade de CRM. Ação de leitura, não exige confirmação.', schema: readCustomFieldsSchema, handler: readCustomFields, sensitive: false },
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
