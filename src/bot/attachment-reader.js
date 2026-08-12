import axios from 'axios';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

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
    const rawText = await extract(buffer);
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
