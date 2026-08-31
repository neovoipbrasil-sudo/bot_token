import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { spawn } from 'node:child_process';
import { readAttachment, registerExtractor, truncateText, MAX_DOWNLOAD_BYTES, MAX_TEXT_CHARS } from './attachment-reader.js';

vi.mock('axios');
vi.mock('pdf-parse', () => ({
  default: vi.fn(),
}));
vi.mock('mammoth');
vi.mock('node:child_process');

function fakeChildProcess(stdout) {
  const listeners = {};
  return {
    stdout: { on: (event, cb) => { if (event === 'data') cb(Buffer.from(stdout)); } },
    stderr: { on: () => {} },
    stdin: { write: () => {}, end: () => {} },
    on: (event, cb) => {
      listeners[event] = cb;
      if (event === 'close') cb(0);
    },
  };
}

describe('readAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Register a simple text extractor for testing
    registerExtractor(['txt'], (buffer) => Promise.resolve(buffer.toString('utf-8')));
  });

  it('rejects a download URL whose domain is not the portal\'s bitrix24 domain', async () => {
    const result = await readAttachment({
      url: 'https://evil.example.com/file.txt',
      filename: 'file.txt',
      portalHost: 'neo-voip.bitrix24.com.br',
    });
    expect(result.text).toMatch(/não consegui/i);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('accepts a download URL on a different bitrix24 subdomain than the portal (e.g. CDN)', async () => {
    axios.get.mockResolvedValue({ data: Buffer.from('ok', 'utf-8') });
    const result = await readAttachment({
      url: 'https://cdn.bitrix24.com.br/b24060375/file.txt',
      filename: 'file.txt',
      portalHost: 'neo-voip.bitrix24.com.br',
    });
    expect(axios.get).toHaveBeenCalled();
    expect(result.text).toContain('ok');
  });

  it('extracts plain text for txt/csv/md attachments', async () => {
    axios.get.mockResolvedValue({ data: Buffer.from('nome,status\nMaria,Novo', 'utf-8') });
    const result = await readAttachment({
      url: 'https://minhaempresa.bitrix24.com.br/file.csv',
      filename: 'clientes.csv',
      portalHost: 'minhaempresa.bitrix24.com.br',
    });
    expect(result.text).toContain('nome,status\nMaria,Novo');
  });

  it('extracts text from pdf attachments via pdf-parse', async () => {
    const pdfParseModule = await import('pdf-parse');
    axios.get.mockResolvedValue({ data: Buffer.from('fake-pdf-bytes') });
    pdfParseModule.default.mockResolvedValue({ text: 'Contrato de prestação de serviços...' });

    const result = await readAttachment({
      url: 'https://minhaempresa.bitrix24.com.br/file.pdf',
      filename: 'contrato.pdf',
      portalHost: 'minhaempresa.bitrix24.com.br',
    });

    expect(result.text).toContain('Contrato de prestação de serviços');
  });

  it('extracts text from docx attachments via mammoth', async () => {
    const mammothModule = await import('mammoth');
    axios.get.mockResolvedValue({ data: Buffer.from('fake-docx-bytes') });
    mammothModule.default.extractRawText.mockResolvedValue({ value: 'Termos e condições do contrato...' });

    const result = await readAttachment({
      url: 'https://minhaempresa.bitrix24.com.br/file.docx',
      filename: 'termos.docx',
      portalHost: 'minhaempresa.bitrix24.com.br',
    });

    expect(result.text).toContain('Termos e condições do contrato');
  });

  it('extracts tabular text from xlsx attachments via exceljs', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Vendas');
    sheet.addRow(['Nome', 'Status']);
    sheet.addRow(['Maria', 'Novo']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    axios.get.mockResolvedValue({ data: buffer });

    const result = await readAttachment({
      url: 'https://minhaempresa.bitrix24.com.br/file.xlsx',
      filename: 'vendas.xlsx',
      portalHost: 'minhaempresa.bitrix24.com.br',
    });

    expect(result.text).toContain('Nome\tStatus');
    expect(result.text).toContain('Maria\tNovo');
  });

  it('describes image attachments via a scoped claude CLI subprocess and cleans up the temp dir', async () => {
    axios.get.mockResolvedValue({ data: Buffer.from('fake-png-bytes') });
    spawn.mockReturnValue(fakeChildProcess(JSON.stringify({ result: 'Print de tela mostrando um erro 500 no formulário de checkout.' })));

    const result = await readAttachment({
      url: 'https://minhaempresa.bitrix24.com.br/file.png',
      filename: 'erro.png',
      portalHost: 'minhaempresa.bitrix24.com.br',
    });

    expect(result.text).toContain('Print de tela mostrando um erro 500');
    expect(spawn).toHaveBeenCalledWith('claude', expect.arrayContaining(['-p', '--output-format', 'json']), expect.objectContaining({ cwd: expect.any(String) }));
  });

  it('tolerates markdown-fenced JSON from the claude CLI when describing images', async () => {
    axios.get.mockResolvedValue({ data: Buffer.from('fake-jpg-bytes') });
    const fenced = '```json\n' + JSON.stringify({ result: 'Foto de um crachá de identificação.' }) + '\n```';
    spawn.mockReturnValue(fakeChildProcess(fenced));

    const result = await readAttachment({
      url: 'https://minhaempresa.bitrix24.com.br/file.jpg',
      filename: 'cracha.jpg',
      portalHost: 'minhaempresa.bitrix24.com.br',
    });

    expect(result.text).toContain('Foto de um crachá de identificação');
  });

  it('rejects an attachment larger than the 15MB download limit without downloading it', async () => {
    const result = await readAttachment({
      url: 'https://minhaempresa.bitrix24.com.br/file.txt',
      filename: 'grande.txt',
      size: MAX_DOWNLOAD_BYTES + 1,
      portalHost: 'minhaempresa.bitrix24.com.br',
    });

    expect(result.text).toMatch(/maior que 15MB/i);
    expect(result.truncated).toBe(false);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('reports an unsupported format without attempting to download it', async () => {
    const result = await readAttachment({
      url: 'https://minhaempresa.bitrix24.com.br/file.zip',
      filename: 'arquivo.zip',
      portalHost: 'minhaempresa.bitrix24.com.br',
    });

    expect(result.text).toMatch(/não é suportado/i);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('truncates extracted text longer than MAX_TEXT_CHARS and flags it as truncated', async () => {
    const longText = 'a'.repeat(MAX_TEXT_CHARS + 500);
    axios.get.mockResolvedValue({ data: Buffer.from(longText, 'utf-8') });

    const result = await readAttachment({
      url: 'https://minhaempresa.bitrix24.com.br/file.txt',
      filename: 'longo.txt',
      portalHost: 'minhaempresa.bitrix24.com.br',
    });

    expect(result.truncated).toBe(true);
    expect(result.text).toContain('[...documento truncado, era maior que o limite de leitura]');
    expect(result.text.length).toBeLessThan(longText.length);
  });
});

describe('truncateText', () => {
  it('returns text unchanged when at or under the limit', () => {
    const text = 'a'.repeat(MAX_TEXT_CHARS);
    const result = truncateText(text);
    expect(result).toEqual({ text, truncated: false });
  });

  it('cuts text down to MAX_TEXT_CHARS and marks it truncated when over the limit', () => {
    const text = 'a'.repeat(MAX_TEXT_CHARS + 100);
    const result = truncateText(text);
    expect(result.text).toHaveLength(MAX_TEXT_CHARS);
    expect(result.truncated).toBe(true);
  });
});
