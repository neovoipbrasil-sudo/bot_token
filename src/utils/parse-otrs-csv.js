import fs from 'fs';

// Parser mínimo de CSV com delimitador ';', aspas e campos multi-linha (formato de exportação do OTRS).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ';') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // ignora, o \n seguinte finaliza a linha
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

const PRIORIDADE_MAP = { Urgente: 'Emergencial', Normal: 'Normal', Alta: 'Alta', Baixa: 'Normal' };

function cleanEmpresaOtrs(e) {
  if (!e) return '—';
  const half = Math.floor(e.length / 2);
  const a = e.slice(0, half);
  const b = e.slice(half);
  return (a === b ? a : e).trim();
}

// Carrega e converte um export CSV do OTRS para o mesmo formato de "row" usado pelos tickets do Bitrix24.
export function loadOtrsTickets(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf-8');
  const rows = parseCsv(text);
  const header = rows[0];
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));

  return rows.slice(1).map((r) => {
    const numero = r[idx['Número do Chamado']];
    const assunto = (r[idx['Assunto']] || '').replace(/^\[Ticket#\d+\]\s*/, '').trim();
    const criado = (r[idx['Criado']] || '').replace(' ', 'T');
    const fechadoRaw = (r[idx['Fechado']] || '').trim();
    const fechado = fechadoRaw ? fechadoRaw.replace(' ', 'T') : null;
    const estado = r[idx['Estado']] || '';
    const status = estado === 'Fechado' ? 'Concluída' : estado === 'Aberto' ? 'Em execução' : 'Aguardando execução';
    const tecnico = `${r[idx['UserFirstname']] || ''} ${r[idx['UserLastname']] || ''}`.trim() || r[idx['Proprietário']] || null;

    return {
      id: 'otrs-' + numero,
      titulo: assunto || numero,
      status,
      created: criado,
      closed: estado === 'Fechado' ? fechado : null,
      empresa: cleanEmpresaOtrs(r[idx['Customer Realname']] || r[idx['ID do Cliente']]),
      problema: assunto || '—',
      categoria: r[idx['Fila']] || '—',
      prioridade: PRIORIDADE_MAP[r[idx['Prioridade']]] || 'Normal',
      statusResumo: null,
      resumoStatus: null,
      tecnico,
      origem: 'otrs',
    };
  });
}
