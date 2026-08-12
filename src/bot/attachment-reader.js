import axios from 'axios';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
export const MAX_TEXT_CHARS = 20_000;

const EXTRACTORS = {};

export function registerExtractor(extensions, fn) {
  for (const ext of extensions) EXTRACTORS[ext] = fn;
}

function extensionOf(filename) {
  const match = /\.([a-zA-Z0-9]+)$/.exec(filename || '');
  return match ? match[1].toLowerCase() : '';
}

// Bitrix24 can serve file downloads from a different subdomain than the
// portal's own REST host (e.g. a CDN subdomain) — compare against the
// shared "bitrix24.<tld>" base domain derived from the portal's own
// hostname, not an exact hostname match.
function sameBitrixDomain(url, portalHost) {
  try {
    const downloadHost = new URL(url).hostname;
    const match = /(bitrix24\.[a-z.]+)$/i.exec(portalHost || '');
    if (!match) return downloadHost === portalHost;
    const baseDomain = match[1].toLowerCase();
    const lowerDownloadHost = downloadHost.toLowerCase();
    return lowerDownloadHost === baseDomain || lowerDownloadHost.endsWith(`.${baseDomain}`);
  } catch {
    return false;
  }
}

export function truncateText(text) {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true };
}

async function downloadAttachment(url, portalHost) {
  if (!sameBitrixDomain(url, portalHost)) {
    throw new Error('URL de anexo fora do domínio esperado do Bitrix24.');
  }

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30_000,
    maxContentLength: MAX_DOWNLOAD_BYTES,
    maxBodyLength: MAX_DOWNLOAD_BYTES,
  });

  return Buffer.from(response.data);
}

export async function readAttachment({ url, filename, size, portalHost }) {
  try {
    if (size && size > MAX_DOWNLOAD_BYTES) {
      return { text: `[Anexo: ${filename}]\nNão consegui ler: arquivo maior que 15MB, manda uma versão menor.`, truncated: false };
    }

    const ext = extensionOf(filename);
    const extract = EXTRACTORS[ext];
    if (!extract) {
      return { text: `[Anexo: ${filename}]\nNão consegui ler: formato ".${ext}" ainda não é suportado.`, truncated: false };
    }

    const buffer = await downloadAttachment(url, portalHost);
    const rawText = await extract(buffer, ext);
    const { text, truncated } = truncateText(rawText);
    const suffix = truncated ? '\n[...documento truncado, era maior que o limite de leitura]' : '';
    return { text: `[Anexo: ${filename}]\n${text}${suffix}`, truncated };
  } catch (err) {
    return { text: `[Anexo: ${filename}]\nNão consegui ler esse anexo: ${err.message}`, truncated: false };
  }
}

registerExtractor(['txt', 'csv', 'md'], async buffer => buffer.toString('utf-8'));

registerExtractor(['pdf'], async buffer => {
  const data = await pdfParse(buffer);
  return data.text;
});

registerExtractor(['docx'], async buffer => {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
});

registerExtractor(['xlsx'], async buffer => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const lines = [];
  workbook.eachSheet(sheet => {
    lines.push(`# ${sheet.name}`);
    sheet.eachRow(row => {
      lines.push(row.values.slice(1).map(v => (v ?? '').toString()).join('\t'));
    });
  });
  return lines.join('\n');
});

function runClaudeOnImage(imagePath) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '-p',
      '--output-format', 'json',
      '--no-session-persistence',
      '--safe-mode',
      '--allowedTools', 'Read',
      '--add-dir', path.dirname(imagePath),
    ], { cwd: path.dirname(imagePath), stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`claude exited with code ${code} ao descrever imagem`));
      resolve(stdout);
    });
    child.stdin.write(`Leia o arquivo de imagem "${path.basename(imagePath)}" com a ferramenta Read e descreva objetivamente o que está escrito e visível nele, em português do Brasil.`);
    child.stdin.end();
  });
}

async function describeImage(buffer, extension) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bot-attachment-'));
  try {
    const imagePath = path.join(dir, `imagem.${extension}`);
    await writeFile(imagePath, buffer);
    const stdout = await runClaudeOnImage(imagePath);
    const envelope = JSON.parse(stdout);
    return envelope.result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

registerExtractor(['png', 'jpg', 'jpeg'], async (buffer, ext) => describeImage(buffer, ext));
