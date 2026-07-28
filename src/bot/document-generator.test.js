import { describe, it, expect } from 'vitest';
import { buildDocument } from './document-generator.js';

describe('document-generator', () => {
  it('builds a plain text document as a utf-8 buffer', async () => {
    const { buffer, extension, mimeType } = await buildDocument({ format: 'txt', content: 'Olá, mundo!' });
    expect(buffer.toString('utf-8')).toBe('Olá, mundo!');
    expect(extension).toBe('txt');
    expect(mimeType).toBe('text/plain');
  });

  it('builds a markdown document', async () => {
    const { buffer, extension } = await buildDocument({ format: 'md', content: '# Título\n\nTexto.' });
    expect(buffer.toString('utf-8')).toContain('# Título');
    expect(extension).toBe('md');
  });

  it('builds an html document', async () => {
    const { buffer, extension } = await buildDocument({ format: 'html', content: '<h1>Oi</h1>' });
    expect(buffer.toString('utf-8')).toBe('<h1>Oi</h1>');
    expect(extension).toBe('html');
  });

  it('builds a csv document from rows, escaping commas and quotes', async () => {
    const { buffer, extension } = await buildDocument({
      format: 'csv',
      rows: [['Nome', 'Cidade'], ['João, Jr.', 'São Paulo'], ['Ana "A."', 'Rio']],
    });
    const text = buffer.toString('utf-8');
    expect(text).toContain('"João, Jr."');
    expect(text).toContain('"Ana ""A."""');
    expect(extension).toBe('csv');
  });

  it('builds a pdf document as a non-empty buffer starting with the PDF signature', async () => {
    const { buffer, extension, mimeType } = await buildDocument({ format: 'pdf', title: 'Relatório', content: 'Conteúdo do relatório.' });
    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
    expect(extension).toBe('pdf');
    expect(mimeType).toBe('application/pdf');
  });

  it('builds an xlsx document as a non-empty buffer', async () => {
    const { buffer, extension } = await buildDocument({
      format: 'xlsx',
      title: 'Leads',
      rows: [['Nome', 'Status'], ['Maria', 'Novo']],
    });
    expect(buffer.length).toBeGreaterThan(0);
    expect(extension).toBe('xlsx');
  });

  it('throws a clear error for an unsupported format', async () => {
    await expect(buildDocument({ format: 'docx', content: 'x' })).rejects.toThrow('Formato de documento não suportado: docx');
  });

  it('throws a clear error when content is missing for a text-based format', async () => {
    await expect(buildDocument({ format: 'txt' })).rejects.toThrow('content');
  });

  it('throws a clear error when rows is missing for csv', async () => {
    await expect(buildDocument({ format: 'csv' })).rejects.toThrow('rows');
  });
});
