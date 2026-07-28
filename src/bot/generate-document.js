import { z } from 'zod';
import { Bitrix24Client } from '../bitrix24/client.js';
import { resolveWebhook } from '../utils/resolve-webhook.js';
import { buildDocument } from './document-generator.js';

export const generateDocumentSchema = z.object({
  format: z.enum(['txt', 'md', 'html', 'csv', 'pdf', 'xlsx']).describe('Formato do documento a gerar'),
  filename: z.string().describe('Nome do arquivo sem extensão, ex: "relatorio-vendas"'),
  title: z.string().optional().describe('Título do documento. Usado no cabeçalho de PDF e no nome da aba da planilha'),
  content: z.string().optional().describe('Conteúdo textual do documento. Obrigatório para os formatos txt, md, html e pdf'),
  rows: z.array(z.array(z.string())).optional().describe('Linhas da tabela, a primeira linha sendo o cabeçalho. Obrigatório para os formatos csv e xlsx. Ex.: [["Nome","Status"],["Maria","Novo"]]'),
  folder_id: z.union([z.string(), z.number()]).optional().describe('ID da pasta de destino no Disco. Se omitido, usa a pasta raiz do usuário do webhook'),
  webhook_url: z.string().url().optional(),
});

export async function generateDocument({ format, filename, title, content, rows, folder_id, webhook_url }) {
  const client = new Bitrix24Client(resolveWebhook(webhook_url));
  const { buffer, extension } = await buildDocument({ format, title, content, rows });

  if (!folder_id) {
    const storageRes = await client.call('disk.storage.getforapp');
    folder_id = storageRes.result?.ROOT_OBJECT?.ID;
  }

  const name = `${filename}.${extension}`;
  const uploadRes = await client.call('disk.folder.uploadfile', {
    id: folder_id,
    data: { NAME: name },
    fileContent: buffer.toString('base64'),
  });

  const file = uploadRes.result;
  return {
    portal: client.portal,
    file: {
      id: file.ID,
      name: file.NAME,
      size: Number(file.SIZE),
      downloadUrl: file.DOWNLOAD_URL,
    },
  };
}
