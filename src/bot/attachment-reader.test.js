import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { readAttachment, registerExtractor } from './attachment-reader.js';

vi.mock('axios');
vi.mock('pdf-parse', () => ({
  default: vi.fn(),
}));

describe('readAttachment', () => {
  beforeEach(() => {
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
});
