import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(rows) {
  return rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
}

async function buildXlsx(title, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(title?.slice(0, 31) || 'Planilha');
  for (const row of rows) sheet.addRow(row);
  if (rows.length) sheet.getRow(1).font = { bold: true };
  return workbook.xlsx.writeBuffer();
}

function buildPdf(title, content) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    if (title) {
      doc.fontSize(18).text(title, { underline: true });
      doc.moveDown();
    }
    doc.fontSize(12).text(content || '', { align: 'left' });
    doc.end();
  });
}

const FORMATS = {
  txt: { extension: 'txt', mimeType: 'text/plain' },
  md: { extension: 'md', mimeType: 'text/markdown' },
  html: { extension: 'html', mimeType: 'text/html' },
  csv: { extension: 'csv', mimeType: 'text/csv' },
  pdf: { extension: 'pdf', mimeType: 'application/pdf' },
  xlsx: { extension: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
};

export async function buildDocument({ format, title, content, rows }) {
  const meta = FORMATS[format];
  if (!meta) throw new Error(`Formato de documento não suportado: ${format}`);

  if (['txt', 'md', 'html'].includes(format)) {
    if (!content) throw new Error(`O formato "${format}" exige o campo "content".`);
    return { buffer: Buffer.from(content, 'utf-8'), ...meta };
  }

  if (format === 'csv') {
    if (!rows?.length) throw new Error('O formato "csv" exige o campo "rows".');
    return { buffer: Buffer.from(buildCsv(rows), 'utf-8'), ...meta };
  }

  if (format === 'xlsx') {
    if (!rows?.length) throw new Error('O formato "xlsx" exige o campo "rows".');
    return { buffer: Buffer.from(await buildXlsx(title, rows)), ...meta };
  }

  // format === 'pdf'
  if (!content) throw new Error('O formato "pdf" exige o campo "content".');
  return { buffer: await buildPdf(title, content), ...meta };
}
