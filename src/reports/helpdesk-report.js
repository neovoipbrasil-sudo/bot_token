import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Bitrix24Client } from '../bitrix24/client.js';
import { resolveWebhook } from '../utils/resolve-webhook.js';
import { loadOtrsTickets } from '../utils/parse-otrs-csv.js';
import { loadCredentials, protectHtml } from './protect-html.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HELP_DESK_CATEGORY_ID = 36; // Pipeline "Help Desk" no funil de negócios (crm.dealcategory.list)

const STATUS_LABEL = { 1: 'Nova', 2: 'Aguardando execução', 3: 'Em execução', 4: 'Aguardando controle', 5: 'Concluída', 6: 'Adiada', 7: 'Recusada' };

function parseArgs(argv) {
  const args = {
    all: false,
    days: null,
    since: null,
    until: null,
    out: path.join(__dirname, '..', '..', 'reports', 'helpdesk-report.html'),
    otrs: path.join(__dirname, '..', '..', 'data', 'chamados-otrs.csv'),
    publicUrl: process.env.B24_REPORT_PUBLIC_URL || 'https://claude.ai/code/artifact/bd8798d6-ffff-4438-bc48-bf0c5f56a59c',
    usersFile: null,
    noAuth: false,
    panel: false,
  };
  for (const a of argv) {
    const [k, v] = a.replace(/^--/, '').split('=');
    if (k === 'all') args.all = true;
    if (k === 'days') args.days = Number(v);
    if (k === 'since') args.since = v;
    if (k === 'until') args.until = v;
    if (k === 'out') args.out = v;
    if (k === 'otrs') args.otrs = v;
    if (k === 'no-otrs') args.otrs = null;
    if (k === 'public-url') args.publicUrl = v;
    if (k === 'users-file') args.usersFile = v;
    if (k === 'no-auth') args.noAuth = true;
    if (k === 'panel') args.panel = true;
  }
  if (!args.all && args.days === null && args.since === null) args.days = 30;
  // --panel: relatório servido pelo painel /reports do bot, que já exige login. Sai sem criptografia,
  // direto na pasta do painel, e os links de cliente usam o endereço do próprio painel.
  if (args.panel) {
    const reportsDir = process.env.REPORTS_DIR || path.join(__dirname, '..', 'bot', 'data', 'reports');
    if (!argv.some((a) => a.startsWith('--out='))) args.out = path.join(reportsDir, 'helpdesk-report.html');
    if (!argv.some((a) => a.startsWith('--public-url='))) args.publicUrl = '';
    args.noAuth = true;
  }
  return args;
}

// Resolve since/until a partir de {all} OU {days} OU {since, until} explícitos, validando que nada é futuro.
// all:true => sem limite inferior (todo o histórico de registros).
function resolvePeriod({ all, days, since, until } = {}) {
  const now = new Date();
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  let sinceDate = null;
  let untilDate;

  if (all) {
    sinceDate = null;
    untilDate = until ? new Date(until + 'T23:59:59') : now;
  } else if (since || until) {
    sinceDate = since ? new Date(since + 'T00:00:00') : new Date(now - 30 * 24 * 60 * 60 * 1000);
    untilDate = until ? new Date(until + 'T23:59:59') : now;
  } else {
    const d = days ?? 30;
    sinceDate = new Date(now - d * 24 * 60 * 60 * 1000);
    untilDate = now;
  }

  if (sinceDate && isNaN(sinceDate.getTime())) throw new Error(`Data inicial inválida: "${since}". Use o formato AAAA-MM-DD.`);
  if (isNaN(untilDate.getTime())) throw new Error(`Data final inválida: "${until}". Use o formato AAAA-MM-DD.`);
  if (sinceDate && sinceDate > todayEnd) throw new Error('A data inicial não pode ser no futuro.');
  if (untilDate > todayEnd) throw new Error('A data final não pode ser no futuro.');
  if (sinceDate && sinceDate > untilDate) throw new Error('A data inicial não pode ser depois da data final.');

  return { since: sinceDate, until: untilDate };
}

async function fetchAllTasks(client, sinceIso, untilIso) {
  let start = 0;
  const all = [];
  const filter = { '%TITLE': 'ticket' };
  // Só restringe o limite superior quando o usuário pediu uma data final explícita.
  // Filtrar por "<=agora" é redundante (não existem tickets futuros) e o fuso do portal
  // (-03:00) vs. o timestamp em UTC pode excluir tickets criados nas últimas horas.
  if (untilIso) filter['<=CREATED_DATE'] = untilIso;
  if (sinceIso) filter['>=CREATED_DATE'] = sinceIso;
  while (true) {
    const res = await client.call('tasks.task.list', {
      filter,
      select: ['ID', 'TITLE', 'DESCRIPTION', 'STATUS', 'CREATED_DATE', 'CLOSED_DATE', 'CHAT_ID', 'CLOSED_BY'],
      start,
    });
    all.push(...(res.result?.tasks ?? []));
    if (!res.next) break;
    start = res.next;
  }
  return all;
}

async function fetchStatusSummary(client, chatId) {
  if (!chatId || chatId === '0') return null;
  const res = await client.call('im.dialog.messages.get', { DIALOG_ID: 'chat' + chatId, LIMIT: 50 });
  const msgs = res.result?.messages || [];
  for (const m of msgs) {
    const blocks = m.params?.ATTACH?.[0]?.BLOCKS;
    if (blocks && blocks.some((b) => /Resumo de status da tarefa/i.test(b.MESSAGE || ''))) {
      const contentBlock = blocks.find((b) => !/Resumo de status da tarefa/i.test(b.MESSAGE || ''));
      return contentBlock ? contentBlock.MESSAGE : null;
    }
  }
  return null;
}

async function fetchUsers(client, ids) {
  if (ids.length === 0) return {};
  const res = await client.call('user.get', { ID: ids });
  const map = {};
  for (const u of res.result) map[u.ID] = `${u.NAME} ${u.LAST_NAME}`.trim();
  return map;
}

function extractField(desc, label, nextLabels) {
  if (!desc) return '';
  const re = new RegExp(label + '\\s*:?\\s*\\n?\\s*(.+?)(?=\\n(?:' + nextLabels.join('|') + ')|$)', 's');
  const m = desc.match(re);
  return m ? m[1].replace(/\n+/g, ' ').trim() : '';
}

function cleanPrioridade(p) {
  const m = (p || '').match(/Prioridade\s+(\w+)/i);
  return m ? m[1] : p || '—';
}

function cleanEmpresa(e) {
  if (!e) return '—';
  // O formulário de origem às vezes duplica o nome da empresa ("Empresa XEmpresa X")
  const half = Math.floor(e.length / 2);
  const a = e.slice(0, half);
  const b = e.slice(half);
  return (a === b ? a : e).trim();
}

function splitStatusSummary(txt) {
  if (!txt) return { statusResumo: null, textoResumo: null };
  const parts = txt.split(/\n\n/);
  return { statusResumo: parts[0]?.trim() || null, textoResumo: parts.slice(1).join('\n\n').trim() || null };
}

function buildRow(task, statusSummary, tecnico) {
  const d = task.description || '';
  const empresa = extractField(d, 'Empresa associada', ['-{5,}', 'TIPO DA SOLICITAÇÃO']);
  const problema =
    extractField(d, 'Transcrever a mensagem do cliente.*?\\n\\n', ['ANEXO', '-{5,}']) ||
    extractField(d, 'DESCRIÇÃO DETALHADA', ['ANEXO', '-{5,}']);
  const categoria = extractField(d, 'PABX, rede, WhatsApp\\)\\.?\\s*\\n', ['-{5,}', 'PRIORIDADE']);
  const prioridadeRaw = extractField(d, 'Alto, Médio, Baixo\\)\\.?\\s*\\n', ['$']);
  const { statusResumo, textoResumo } = splitStatusSummary(statusSummary);

  return {
    id: task.id,
    titulo: task.title.replace(/^TICKET\s*/i, '').trim(),
    status: STATUS_LABEL[task.status] || task.status,
    created: task.createdDate,
    closed: task.closedDate || null,
    empresa: cleanEmpresa(empresa),
    problema: (problema || d.slice(0, 200)).trim() || '—',
    categoria: (categoria || '—').trim(),
    prioridade: cleanPrioridade(prioridadeRaw),
    statusResumo,
    resumoStatus: textoResumo,
    tecnico: tecnico || null,
    origem: 'bitrix24',
  };
}

export async function collectHelpDeskReportData({ all, days, since: sinceArg, until: untilArg, otrsPath } = {}) {
  const client = new Bitrix24Client(resolveWebhook());
  const { since, until } = resolvePeriod({ all, days, since: sinceArg, until: untilArg });
  const sinceIso = since ? since.toISOString().slice(0, 19) : null;
  const untilIso = untilArg ? until.toISOString().slice(0, 19) : null;

  const tasks = await fetchAllTasks(client, sinceIso, untilIso);

  const statusSummaries = {};
  for (const t of tasks) {
    statusSummaries[t.id] = await fetchStatusSummary(client, t.chatId);
  }

  const userIds = [...new Set(tasks.map((t) => t.closedBy).filter(Boolean))];
  const users = await fetchUsers(client, userIds);

  const bitrixRows = tasks.map((t) =>
    buildRow(t, statusSummaries[t.id], t.closedBy ? users[t.closedBy] || `Usuário ${t.closedBy}` : null)
  );

  const otrsRows = otrsPath
    ? loadOtrsTickets(otrsPath).filter((r) => {
        const d = new Date(r.created);
        return (!since || d >= since) && d <= until;
      })
    : [];

  const rows = [...bitrixRows, ...otrsRows]
    .map((r) => ({
      ...r,
      tempoAtendimentoMin: r.closed ? (new Date(r.closed) - new Date(r.created)) / 60000 : null,
    }))
    .sort((a, b) => new Date(a.created) - new Date(b.created));

  return { rows, since, until, generatedAt: new Date(), portal: client.portal, categoryId: HELP_DESK_CATEGORY_ID };
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function fmtDuration(min) {
  if (min == null) return '—';
  if (min < 60) return Math.round(min) + 'min';
  const totalHours = min / 60;
  if (totalHours < 24) {
    const h = Math.floor(totalHours);
    const m = Math.round(min - h * 60);
    return m ? `${h}h ${m}min` : `${h}h`;
  }
  const days = Math.floor(totalHours / 24);
  const h = Math.round(totalHours - days * 24);
  return h ? `${days}d ${h}h` : `${days}d`;
}

function median(sortedNums) {
  if (!sortedNums.length) return null;
  const mid = Math.floor(sortedNums.length / 2);
  return sortedNums.length % 2 ? sortedNums[mid] : (sortedNums[mid - 1] + sortedNums[mid]) / 2;
}

const STATUS_CLASS = { Concluída: 'st-done', 'Em execução': 'st-progress', 'Aguardando execução': 'st-pending' };
const PRIO_CLASS = { Alta: 'p-alta', Emergencial: 'p-emerg', Normal: 'p-normal', '—': 'p-none' };
const PRIO_LABEL = { Alta: 'Alta', Emergencial: 'Emergencial', Normal: 'Normal', '—': 'Sem prioridade' };

export function renderHelpDeskReportHtml({ rows, since, until, generatedAt, publicUrl }) {
  const total = rows.length;
  const earliestCreated = rows.length ? new Date(Math.min(...rows.map((r) => new Date(r.created)))) : until;
  const effectiveSince = since || earliestCreated;
  const isAllTime = !since;
  const days = Math.max(1, Math.round((until - effectiveSince) / (24 * 60 * 60 * 1000)));
  const comResumo = rows.filter((r) => r.resumoStatus).length;
  const otrsCount = rows.filter((r) => r.origem === 'otrs').length;

  const byStatus = {};
  rows.forEach((r) => (byStatus[r.status] = (byStatus[r.status] || 0) + 1));
  const byPrio = {};
  rows.forEach((r) => (byPrio[r.prioridade] = (byPrio[r.prioridade] || 0) + 1));
  const byTecnico = {};
  rows.forEach((r) => {
    const k = r.tecnico || 'Sem técnico';
    byTecnico[k] = (byTecnico[k] || 0) + 1;
  });
  const empresas = [...new Set(rows.map((r) => r.empresa).filter((e) => e && e !== '—'))].sort((a, b) =>
    a.localeCompare(b, 'pt-BR')
  );

  const duracoes = rows.map((r) => r.tempoAtendimentoMin).filter((m) => m != null);
  const semTempo = total - duracoes.length;
  const avgMin = duracoes.length ? duracoes.reduce((a, b) => a + b, 0) / duracoes.length : null;
  const medianMin = median([...duracoes].sort((a, b) => a - b));

  const statusOrder = ['Concluída', 'Em execução', 'Aguardando execução'];
  const prioOrder = ['Emergencial', 'Alta', 'Normal', '—'];
  const tecnicoOrder = Object.keys(byTecnico).sort((a, b) => byTecnico[b] - byTecnico[a]);
  const maxTecnico = Math.max(...tecnicoOrder.map((t) => byTecnico[t]), 1);

  const statPills = statusOrder
    .filter((s) => byStatus[s])
    .map((s) => `<button class="filter-pill ${STATUS_CLASS[s]}" data-filter="${esc(s)}">${esc(s)} <b>${byStatus[s]}</b></button>`)
    .join('');

  const prioBars = prioOrder
    .filter((p) => byPrio[p])
    .map((p) => {
      const pct = Math.round((byPrio[p] / total) * 100);
      return `<div class="prio-item">
    <div class="prio-item-head">
      <span class="prio-swatch ${PRIO_CLASS[p]}"></span>
      <span class="prio-name">${esc(PRIO_LABEL[p] || p)}</span>
      <span class="prio-count">${byPrio[p]}</span>
    </div>
    <div class="prio-track"><div class="prio-fill ${PRIO_CLASS[p]}" style="width:${pct}%"></div></div>
  </div>`;
    })
    .join('');

  const avgByPrio = {};
  prioOrder.forEach((p) => {
    const durs = rows.filter((r) => r.prioridade === p && r.tempoAtendimentoMin != null).map((r) => r.tempoAtendimentoMin);
    avgByPrio[p] = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : null;
  });
  const maxAvgPrio = Math.max(...prioOrder.map((p) => avgByPrio[p] || 0), 1);
  const tempoPorPrioridade = prioOrder
    .filter((p) => avgByPrio[p] != null)
    .map((p) => {
      const pct = Math.round((avgByPrio[p] / maxAvgPrio) * 100);
      return `<div class="prio-item">
    <div class="prio-item-head">
      <span class="prio-swatch ${PRIO_CLASS[p]}"></span>
      <span class="prio-name">${esc(PRIO_LABEL[p] || p)}</span>
      <span class="prio-count">${fmtDuration(avgByPrio[p])}</span>
    </div>
    <div class="prio-track"><div class="prio-fill ${PRIO_CLASS[p]}" style="width:${pct}%"></div></div>
  </div>`;
    })
    .join('');

  const tecnicoBars = tecnicoOrder
    .map((t) => {
      const pct = Math.round((byTecnico[t] / maxTecnico) * 100);
      const cls = t === 'Sem técnico' ? 'p-none' : 'p-tecnico';
      return `<div class="prio-row tecnico-row" data-tecnico="${esc(t)}" tabindex="0" role="button">
    <span class="prio-label tecnico-label" title="${esc(t)}">${esc(t)}</span>
    <div class="prio-track"><div class="prio-fill ${cls}" style="width:${pct}%"></div></div>
    <span class="prio-count">${byTecnico[t]}</span>
  </div>`;
    })
    .join('');

  const empresaOptions = empresas.map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join('');

  const tableRows = rows
    .map((r, idx) => {
      const rowId = 'r' + idx;
      const hasResumo = !!r.resumoStatus;
      const resumoStatusClass = r.statusResumo === 'Resolvido' ? 'rs-ok' : r.statusResumo ? 'rs-other' : '';
      return `
        <tr data-status="${esc(r.status)}" data-empresa="${esc(r.empresa)}" data-tecnico="${esc(r.tecnico || 'Sem técnico')}" data-created="${new Date(r.created).toISOString().slice(0, 10)}" data-origem="${esc(r.origem)}" class="ticket-row ${hasResumo ? 'has-resumo' : ''}" data-target="${rowId}">
          <td class="col-ticket">${r.origem === 'otrs' ? '<span class="origem-tag" title="Importado do OTRS">OTRS</span>' : ''}<span class="ticket-id">${esc(r.titulo.split(' - ')[0])}</span><span class="ticket-date">${fmtDate(r.created)}</span></td>
          <td class="col-empresa">${esc(r.empresa)}</td>
          <td class="col-resumo">${esc(r.problema)}</td>
          <td class="col-categoria">${esc(r.categoria)}</td>
          <td class="col-prioridade"><span class="prio ${PRIO_CLASS[r.prioridade] || 'p-none'}">${esc(PRIO_LABEL[r.prioridade] || r.prioridade)}</span></td>
          <td class="col-status"><span class="status ${STATUS_CLASS[r.status] || ''}">${esc(r.status)}</span></td>
          <td class="col-tempo">${fmtDuration(r.tempoAtendimentoMin)}</td>
          <td class="col-tecnico">${r.tecnico ? esc(r.tecnico) : '<span class="no-resumo">—</span>'}</td>
          <td class="col-expand">${hasResumo ? `<button class="expand-btn" aria-expanded="false" aria-controls="${rowId}">Ver <span class="chevron">▾</span></button>` : `<span class="no-resumo">—</span>`}</td>
        </tr>${
          hasResumo
            ? `
        <tr class="resumo-row" id="${rowId}" hidden>
          <td></td>
          <td colspan="8">
            <div class="resumo-panel">
              <span class="resumo-status-tag ${resumoStatusClass}">${esc(r.statusResumo)}</span>
              <p>${esc(r.resumoStatus)}</p>
            </div>
          </td>
        </tr>`
            : ''
        }`;
    })
    .join('');

  const period = isAllTime
    ? `todo o histórico (desde ${effectiveSince.toLocaleDateString('pt-BR')}) até ${until.toLocaleDateString('pt-BR')}`
    : `${effectiveSince.toLocaleDateString('pt-BR')} a ${until.toLocaleDateString('pt-BR')}`;
  const minDate = earliestCreated.toISOString().slice(0, 10);
  const maxDate = until.toISOString().slice(0, 10);

  return `<title>Relatório Help Desk — ${isAllTime ? 'histórico completo' : days + ' dias'}</title>
<style>
  :root {
    --paper: #eef1ee;
    --paper-raised: #ffffff;
    --ink: #12181a;
    --ink-soft: #4a5559;
    --ink-faint: #7c8a8d;
    --line: #d4dad5;
    --accent: #d9622b;
    --accent-soft: #fbe6d9;
    --good: #2f7d5c;
    --good-soft: #e1f0e8;
    --warn: #b9862a;
    --warn-soft: #f7ecd8;
    --busy: #3b6ea5;
    --busy-soft: #e4edf6;
    --mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
    --sans: ui-sans-serif, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --serif: Georgia, "Iowan Old Style", "Palatino Linotype", serif;
  }
  :root[data-theme="dark"] {
    --paper: #10161a; --paper-raised: #171f24; --ink: #e9edee; --ink-soft: #a9b4b6; --ink-faint: #6c797c;
    --line: #2a3438; --accent: #ef7f42; --accent-soft: #3a2416; --good: #5cbd91; --good-soft: #16261e;
    --warn: #dcae57; --warn-soft: #2e2513; --busy: #7fb0e0; --busy-soft: #16232f;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --paper: #10161a; --paper-raised: #171f24; --ink: #e9edee; --ink-soft: #a9b4b6; --ink-faint: #6c797c;
      --line: #2a3438; --accent: #ef7f42; --accent-soft: #3a2416; --good: #5cbd91; --good-soft: #16261e;
      --warn: #dcae57; --warn-soft: #2e2513; --busy: #7fb0e0; --busy-soft: #16232f;
    }
  }

  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--sans); line-height: 1.45; }
  .page { max-width: 1220px; margin: 0 auto; padding: 2.5rem 1.5rem 5rem; }

  header.report-head {
    display: flex; justify-content: space-between; align-items: flex-end; gap: 2rem; flex-wrap: wrap;
    padding-bottom: 1.75rem; border-bottom: 2px solid var(--ink); margin-bottom: 2rem;
  }
  .eyebrow { font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); margin: 0 0 0.6rem; }
  h1 { font-family: var(--serif); font-size: 2.1rem; font-weight: 400; margin: 0 0 0.35rem; text-wrap: balance; letter-spacing: -0.01em; }
  .subtitle { font-size: 0.95rem; color: var(--ink-soft); margin: 0; }
  .headline-stat { text-align: right; font-family: var(--serif); }
  .headline-stat .num { font-size: 3.2rem; line-height: 1; font-variant-numeric: tabular-nums oldstyle-nums; color: var(--ink); }
  .headline-stat .label { font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-faint); margin-top: 0.15rem; }

  .client-banner {
    display: none;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    background: var(--busy-soft);
    border: 1px solid var(--busy);
    border-radius: 6px;
    padding: 0.75rem 1.1rem;
    margin-bottom: 1.5rem;
    font-size: 0.88rem;
  }
  .client-banner.active { display: flex; }
  .client-banner b { color: var(--busy); }
  .client-banner button { font-family: var(--mono); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; background: none; border: 1px solid var(--busy); color: var(--busy); border-radius: 4px; padding: 0.3rem 0.6rem; cursor: pointer; }

  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
  .stat-card { background: var(--paper-raised); border: 1px solid var(--line); border-radius: 6px; padding: 1.1rem 1.25rem; min-width: 0; overflow: hidden; }
  .stat-card h2 { font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-faint); margin: 0 0 0.75rem; font-weight: 500; }
  .stat-card .stat-note { font-size: 0.78rem; color: var(--ink-soft); margin: 0.6rem 0 0; }

  .prio-row { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.5rem; }
  .prio-row:last-child { margin-bottom: 0; }
  .prio-label { font-family: var(--mono); font-size: 0.72rem; width: 5.4rem; flex-shrink: 0; }
  .prio-track { flex: 1; height: 7px; background: var(--paper); border-radius: 4px; overflow: hidden; }
  .prio-fill { height: 100%; border-radius: 4px; }
  .prio-count { font-family: var(--mono); font-size: 0.78rem; color: var(--ink-soft); font-variant-numeric: tabular-nums; }
  .prio-row .prio-count { width: 1.6rem; text-align: right; }
  .p-alta, .prio-fill.p-alta, .prio-swatch.p-alta { color: var(--accent); background: var(--accent); }
  .p-emerg, .prio-fill.p-emerg, .prio-swatch.p-emerg { color: #b03a2e; background: #b03a2e; }
  .p-normal, .prio-fill.p-normal, .prio-swatch.p-normal { color: var(--busy); background: var(--busy); }
  .p-none, .prio-fill.p-none, .prio-swatch.p-none { color: var(--ink-faint); background: var(--ink-faint); }
  .prio-fill.p-tecnico { background: var(--good); }

  .prio-item { margin-bottom: 0.7rem; }
  .prio-item:last-child { margin-bottom: 0; }
  .prio-item-head { display: flex; align-items: center; gap: 0.45rem; margin-bottom: 0.35rem; }
  .prio-swatch { width: 0.6rem; height: 0.6rem; border-radius: 50%; flex-shrink: 0; }
  .prio-name { flex: 1; font-family: var(--sans); font-size: 0.82rem; color: var(--ink); font-weight: 500; }
  .prio-item .prio-count { font-size: 0.78rem; }
  .tecnico-label { width: 9.5rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tecnico-row { cursor: pointer; border-radius: 4px; padding: 0.15rem 0.35rem; margin: 0 -0.35rem 0.5rem; }
  .tecnico-row:last-child { margin-bottom: 0; }
  .tecnico-row:hover { background: var(--paper); }
  .tecnico-row:focus-visible { outline: 2px solid var(--busy); outline-offset: 1px; }
  .tecnico-row.active { background: var(--busy-soft); }
  .tecnico-row.active .tecnico-label { color: var(--busy); font-weight: 600; }
  .mini-clear {
    font-family: var(--mono); font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.04em;
    background: none; border: none; color: var(--busy); cursor: pointer; padding: 0; margin-left: 0.5rem; text-decoration: underline;
  }

  .filter-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .filter-pill {
    font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.02em; border: 1px solid var(--line);
    background: var(--paper); color: var(--ink-soft); padding: 0.45rem 0.7rem; border-radius: 999px; cursor: pointer; transition: transform 0.1s ease;
  }
  .filter-pill b { font-variant-numeric: tabular-nums; margin-left: 0.3rem; }
  .filter-pill:hover { transform: translateY(-1px); }
  .filter-pill.active { color: var(--paper-raised); border-color: transparent; }
  .filter-pill.st-done.active { background: var(--good); }
  .filter-pill.st-progress.active { background: var(--busy); }
  .filter-pill.st-pending.active { background: var(--warn); }
  .filter-pill.all.active { background: var(--ink); }

  .empresa-filter { display: flex; flex-direction: column; gap: 0.4rem; }
  .empresa-filter input {
    font-family: var(--sans); font-size: 0.85rem; padding: 0.5rem 0.7rem; border: 1px solid var(--line);
    border-radius: 6px; background: var(--paper); color: var(--ink); width: 100%;
  }
  .empresa-filter input:focus { outline: 2px solid var(--busy); outline-offset: 1px; }

  .periodo-filter { display: flex; flex-direction: column; gap: 0.4rem; min-width: 0; }
  .periodo-inputs { display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; }
  .periodo-inputs label { display: flex; flex-direction: column; gap: 0.25rem; font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-faint); min-width: 0; }
  .periodo-inputs input {
    font-family: var(--sans); font-size: 0.85rem; padding: 0.45rem 0.6rem; border: 1px solid var(--line);
    border-radius: 6px; background: var(--paper); color: var(--ink); width: 100%; min-width: 0; box-sizing: border-box; color-scheme: light dark;
  }
  .periodo-inputs input:focus { outline: 2px solid var(--busy); outline-offset: 1px; }
  #periodo-clear-btn {
    font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.04em; text-transform: uppercase;
    background: var(--paper); color: var(--ink-soft); border: 1px solid var(--line); border-radius: 4px; padding: 0.4rem 0.6rem; cursor: pointer; white-space: nowrap;
  }
  .share-link-row { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.5rem; }
  .share-link-row button {
    font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.04em; text-transform: uppercase;
    background: var(--good-soft); color: var(--good); border: none; border-radius: 4px; padding: 0.4rem 0.6rem; cursor: pointer; white-space: nowrap;
  }
  .share-link-row button:disabled { opacity: 0.4; cursor: not-allowed; }
  .share-hint { font-size: 0.72rem; color: var(--ink-faint); margin: 0; }
  .share-link-display {
    font-family: var(--mono); font-size: 0.72rem; padding: 0.4rem 0.6rem; border: 1px solid var(--line);
    border-radius: 6px; background: var(--paper); color: var(--ink-soft); width: 100%; box-sizing: border-box;
    margin-top: 0.5rem;
  }

  .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 6px; background: var(--paper-raised); }
  table { border-collapse: collapse; width: 100%; min-width: 1080px; font-size: 0.86rem; }
  thead th {
    text-align: left; font-family: var(--mono); font-size: 0.66rem; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--ink-faint); font-weight: 500; padding: 0.7rem 0.9rem; border-bottom: 1px solid var(--line);
    position: sticky; top: 0; background: var(--paper-raised);
  }
  tbody td { padding: 0.65rem 0.9rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  tbody tr.ticket-row:last-of-type td { border-bottom: none; }
  tbody tr.ticket-row:hover { background: var(--paper); cursor: default; }
  tbody tr.ticket-row.has-resumo { cursor: pointer; }
  .col-ticket { white-space: nowrap; font-family: var(--mono); }
  .origem-tag {
    display: inline-block; font-size: 0.6rem; letter-spacing: 0.04em; font-weight: 600;
    background: var(--warn-soft); color: var(--warn); border-radius: 3px; padding: 0.05rem 0.3rem; margin-right: 0.35rem;
  }
  .ticket-id { display: block; font-size: 0.78rem; color: var(--ink); }
  .ticket-date { display: block; font-size: 0.68rem; color: var(--ink-faint); margin-top: 0.1rem; }
  .col-empresa { max-width: 180px; font-weight: 600; }
  .col-resumo { max-width: 300px; color: var(--ink-soft); }
  .col-categoria { max-width: 150px; font-family: var(--mono); font-size: 0.76rem; color: var(--ink-soft); }
  .col-prioridade, .col-status, .col-expand { white-space: nowrap; }
  .col-tempo { white-space: nowrap; font-family: var(--mono); font-size: 0.78rem; color: var(--ink-soft); }
  .col-tecnico { max-width: 150px; color: var(--ink-soft); font-size: 0.82rem; }

  .expand-btn {
    font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--busy);
    background: var(--busy-soft); border: none; padding: 0.22rem 0.55rem; border-radius: 4px; cursor: pointer;
  }
  .expand-btn .chevron { display: inline-block; transition: transform 0.15s ease; }
  .expand-btn[aria-expanded="true"] .chevron { transform: rotate(-180deg); }
  .no-resumo { color: var(--ink-faint); font-family: var(--mono); font-size: 0.75rem; }

  .resumo-row td { padding: 0; border-bottom: 1px solid var(--line); }
  .resumo-panel { background: var(--paper); padding: 0.9rem 1.1rem; border-left: 3px solid var(--good); }
  .resumo-panel p { margin: 0.5rem 0 0; color: var(--ink); font-size: 0.87rem; max-width: 68ch; white-space: pre-line; }
  .resumo-status-tag {
    font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.04em; text-transform: uppercase;
    padding: 0.2rem 0.5rem; border-radius: 4px; background: var(--good-soft); color: var(--good);
  }
  .resumo-status-tag.rs-other { background: var(--warn-soft); color: var(--warn); }

  .prio, .status {
    font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.04em; text-transform: uppercase;
    padding: 0.22rem 0.5rem; border-radius: 4px; white-space: nowrap;
  }
  .prio.p-alta { color: var(--accent); background: var(--accent-soft); }
  .prio.p-emerg { color: #b03a2e; background: #fbe1dd; }
  .prio.p-normal { color: var(--busy); background: var(--busy-soft); }
  .prio.p-none { color: var(--ink-faint); background: var(--paper); }
  .status.st-done { color: var(--good); background: var(--good-soft); }
  .status.st-progress { color: var(--busy); background: var(--busy-soft); }
  .status.st-pending { color: var(--warn); background: var(--warn-soft); }

  .table-head-row { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
  .table-head-row h2 { font-family: var(--mono); font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); margin: 0; font-weight: 500; }
  .count-note { font-family: var(--mono); font-size: 0.72rem; color: var(--ink-faint); }

  footer.report-foot {
    margin-top: 2.5rem; padding-top: 1.25rem; border-top: 1px solid var(--line); font-family: var(--mono);
    font-size: 0.7rem; color: var(--ink-faint); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem;
  }

  @media (max-width: 640px) {
    .headline-stat { text-align: left; }
    header.report-head { flex-direction: column; align-items: flex-start; }
  }
</style>

<div class="page">
  <header class="report-head">
    <div>
      <p class="eyebrow">Neo Voip · CRM Bitrix24 · Pipeline Help Desk</p>
      <h1>Relatório de tickets — ${isAllTime ? 'histórico completo' : days + ' dias'}</h1>
      <p class="subtitle" id="period-subtitle">${esc(period)} · tarefas do módulo Tasks vinculadas aos negócios da categoria Help Desk</p>
    </div>
    <div class="headline-stat">
      <div class="num" id="headline-num">${total}</div>
      <div class="label" id="headline-label">tickets abertos</div>
    </div>
  </header>

  <div class="client-banner" id="client-banner">
    <span>Visualização filtrada para <b id="client-banner-name"></b></span>
    <button id="client-banner-clear">Ver todos os clientes</button>
  </div>

  <div class="stat-grid">
    <div class="stat-card">
      <h2>Status</h2>
      <div class="filter-row" id="filters">
        <button class="filter-pill all active" data-filter="all">Todos <b>${total}</b></button>
        ${statPills}
      </div>
      <p class="stat-note">${comResumo} de ${total} tickets têm resumo de status preenchido pelo técnico.</p>
    </div>
    <div class="stat-card">
      <h2>Prioridade</h2>
      ${prioBars}
    </div>
    <div class="stat-card">
      <h2>Por técnico <button id="tecnico-clear-btn" class="mini-clear" hidden>Limpar</button></h2>
      <p class="stat-note" style="margin:-0.35rem 0 0.6rem;">Clique para filtrar — pode selecionar mais de um.</p>
      <div id="tecnico-bars">${tecnicoBars}</div>
    </div>
    <div class="stat-card">
      <h2>Tempo de atendimento</h2>
      <p class="stat-note" style="margin-top:0;">Média <b>${fmtDuration(avgMin)}</b> · Mediana <b>${fmtDuration(medianMin)}</b>${semTempo ? ` · ${semTempo} sem data de fechamento` : ''}</p>
      ${tempoPorPrioridade}
    </div>
    <div class="stat-card">
      <h2>Filtrar por cliente</h2>
      <div class="empresa-filter">
        <input list="empresa-list" id="empresa-input" placeholder="Digite ou escolha o nome do cliente…" autocomplete="off" />
        <datalist id="empresa-list">${empresaOptions}</datalist>
        <div class="share-link-row">
          <button id="copy-link-btn" disabled>Copiar link do cliente</button>
          <p class="share-hint" id="share-hint">Escolha um cliente para gerar um link só com os tickets dele.</p>
        </div>
        <input type="text" id="share-link-display" class="share-link-display" readonly hidden />
      </div>
    </div>
    <div class="stat-card">
      <h2>Filtrar por período</h2>
      <div class="periodo-filter">
        <div class="periodo-inputs">
          <label>De <input type="date" id="periodo-inicio" min="${minDate}" max="${maxDate}" /></label>
          <label>Até <input type="date" id="periodo-fim" min="${minDate}" max="${maxDate}" /></label>
        </div>
        <div class="share-link-row">
          <button id="periodo-clear-btn">Limpar período</button>
          <p class="share-hint" id="periodo-hint">Dados carregados: ${esc(period)}.</p>
        </div>
      </div>
    </div>
  </div>

  <div class="table-head-row">
    <h2>Tickets — título e resumo de status</h2>
    <span class="count-note" id="count-note">${total} de ${total} exibidos</span>
  </div>
  <div class="table-wrap">
    <table id="ticket-table">
      <thead>
        <tr>
          <th>Ticket</th>
          <th>Empresa</th>
          <th>Problema relatado</th>
          <th>Categoria</th>
          <th>Prioridade</th>
          <th>Status</th>
          <th>Tempo</th>
          <th>Técnico</th>
          <th>Resumo</th>
        </tr>
      </thead>
      <tbody>${tableRows}
      </tbody>
    </table>
  </div>

  <footer class="report-foot">
    <span>Fonte: tasks.task.list (CLOSED_BY = técnico) + im.dialog.messages.get (resumo de status) — filtro %TITLE=ticket, CREATED_DATE ${isAllTime ? '≤' : 'entre ' + effectiveSince.toISOString().slice(0, 10) + ' e'} ${until.toISOString().slice(0, 10)}${otrsCount ? ` · +${otrsCount} chamados importados do OTRS (histórico externo)` : ''}</span>
    <span>Gerado em ${generatedAt.toLocaleString('pt-BR')}</span>
  </footer>
</div>

<script>
  const pills = document.querySelectorAll('.filter-pill');
  const ticketRows = document.querySelectorAll('#ticket-table tbody tr.ticket-row');
  const note = document.getElementById('count-note');
  const headlineNum = document.getElementById('headline-num');
  const empresaInput = document.getElementById('empresa-input');
  const copyLinkBtn = document.getElementById('copy-link-btn');
  const shareHint = document.getElementById('share-hint');
  const shareLinkDisplay = document.getElementById('share-link-display');
  const clientBanner = document.getElementById('client-banner');
  const clientBannerName = document.getElementById('client-banner-name');
  const clientBannerClear = document.getElementById('client-banner-clear');
  const periodoInicio = document.getElementById('periodo-inicio');
  const periodoFim = document.getElementById('periodo-fim');
  const periodoClearBtn = document.getElementById('periodo-clear-btn');
  const periodoHint = document.getElementById('periodo-hint');
  const periodSubtitle = document.getElementById('period-subtitle');
  const DEFAULT_HINT = periodoHint.textContent;
  const TOTAL = ${total};
  const PUBLIC_URL = ${JSON.stringify(publicUrl || '')};

  function shareUrl() {
    const params = new URL(window.location.href).searchParams;
    const clean = new URLSearchParams();
    ['empresa', 'tecnico', 'inicio', 'fim'].forEach((k) => {
      params.getAll(k).forEach((v) => clean.append(k, v));
    });
    const qs = clean.toString();
    if (PUBLIC_URL) return PUBLIC_URL + (qs ? '?' + qs : '');
    return window.location.origin + window.location.pathname + (qs ? '?' + qs : '');
  }

  let statusFilter = 'all';
  let empresaFilter = '';
  let tecnicoFilter = new Set();
  let periodoInicioFilter = '';
  let periodoFimFilter = '';

  function applyFilters() {
    let shown = 0;
    ticketRows.forEach((r) => {
      const matchStatus = statusFilter === 'all' || r.dataset.status === statusFilter;
      const matchEmpresa = !empresaFilter || r.dataset.empresa.toLowerCase().includes(empresaFilter.toLowerCase());
      const matchTecnico = tecnicoFilter.size === 0 || tecnicoFilter.has(r.dataset.tecnico);
      const matchInicio = !periodoInicioFilter || r.dataset.created >= periodoInicioFilter;
      const matchFim = !periodoFimFilter || r.dataset.created <= periodoFimFilter;
      const match = matchStatus && matchEmpresa && matchTecnico && matchInicio && matchFim;
      r.style.display = match ? '' : 'none';
      const resumoRow = document.getElementById(r.dataset.target);
      if (resumoRow) resumoRow.style.display = match && !resumoRow.hidden ? '' : 'none';
      if (match) shown++;
    });
    note.textContent = shown + ' de ' + TOTAL + ' exibidos';
    headlineNum.textContent = shown;
  }

  pills.forEach((pill) => {
    pill.addEventListener('click', () => {
      pills.forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      statusFilter = pill.dataset.filter;
      applyFilters();
    });
  });

  function setEmpresaFilter(name, fromUrl) {
    empresaFilter = name || '';
    empresaInput.value = empresaFilter;
    applyFilters();
    if (empresaFilter) {
      copyLinkBtn.disabled = false;
      shareHint.textContent = 'Esse link mostra só os tickets de ' + empresaFilter + '.';
      clientBanner.classList.add('active');
      clientBannerName.textContent = empresaFilter;
      shareLinkDisplay.hidden = false;
      shareLinkDisplay.value = shareUrl();
    } else {
      copyLinkBtn.disabled = true;
      shareHint.textContent = 'Escolha um cliente para gerar um link só com os tickets dele.';
      clientBanner.classList.remove('active');
      shareLinkDisplay.hidden = true;
      shareLinkDisplay.value = '';
    }
    if (!fromUrl) {
      const url = new URL(window.location.href);
      if (empresaFilter) url.searchParams.set('empresa', empresaFilter);
      else url.searchParams.delete('empresa');
      window.history.replaceState({}, '', url);
    }
  }

  empresaInput.addEventListener('input', () => setEmpresaFilter(empresaInput.value));
  clientBannerClear.addEventListener('click', () => setEmpresaFilter(''));

  const tecnicoRows = document.querySelectorAll('.tecnico-row');
  const tecnicoClearBtn = document.getElementById('tecnico-clear-btn');

  function syncTecnicoUi(fromUrl) {
    tecnicoRows.forEach((el) => el.classList.toggle('active', tecnicoFilter.has(el.dataset.tecnico)));
    tecnicoClearBtn.hidden = tecnicoFilter.size === 0;
    applyFilters();
    if (!fromUrl) {
      const url = new URL(window.location.href);
      url.searchParams.delete('tecnico');
      tecnicoFilter.forEach((t) => url.searchParams.append('tecnico', t));
      window.history.replaceState({}, '', url);
    }
  }

  function toggleTecnico(t) {
    if (tecnicoFilter.has(t)) tecnicoFilter.delete(t);
    else tecnicoFilter.add(t);
    syncTecnicoUi(false);
  }

  function setTecnicoFilter(list, fromUrl) {
    tecnicoFilter = new Set(list);
    syncTecnicoUi(fromUrl);
  }

  tecnicoRows.forEach((el) => {
    el.addEventListener('click', () => toggleTecnico(el.dataset.tecnico));
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        toggleTecnico(el.dataset.tecnico);
      }
    });
  });
  tecnicoClearBtn.addEventListener('click', () => setTecnicoFilter([]));

  function setPeriodoFilter(inicio, fim, fromUrl) {
    periodoInicioFilter = inicio || '';
    periodoFimFilter = fim || '';
    periodoInicio.value = periodoInicioFilter;
    periodoFim.value = periodoFimFilter;
    applyFilters();
    if (periodoInicioFilter || periodoFimFilter) {
      const de = periodoInicioFilter ? new Date(periodoInicioFilter + 'T00:00:00').toLocaleDateString('pt-BR') : 'o início';
      const ate = periodoFimFilter ? new Date(periodoFimFilter + 'T00:00:00').toLocaleDateString('pt-BR') : 'hoje';
      periodoHint.textContent = 'Mostrando de ' + de + ' até ' + ate + '.';
      periodSubtitle.textContent = 'Filtrado de ' + de + ' até ' + ate + ' · tarefas do módulo Tasks vinculadas aos negócios da categoria Help Desk';
    } else {
      periodoHint.textContent = DEFAULT_HINT;
      periodSubtitle.textContent = ${JSON.stringify(period)} + ' · tarefas do módulo Tasks vinculadas aos negócios da categoria Help Desk';
    }
    if (!fromUrl) {
      const url = new URL(window.location.href);
      if (periodoInicioFilter) url.searchParams.set('inicio', periodoInicioFilter);
      else url.searchParams.delete('inicio');
      if (periodoFimFilter) url.searchParams.set('fim', periodoFimFilter);
      else url.searchParams.delete('fim');
      window.history.replaceState({}, '', url);
    }
  }

  periodoInicio.addEventListener('change', () => setPeriodoFilter(periodoInicio.value, periodoFimFilter));
  periodoFim.addEventListener('change', () => setPeriodoFilter(periodoInicioFilter, periodoFim.value));
  periodoClearBtn.addEventListener('click', () => setPeriodoFilter('', ''));

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }

  shareLinkDisplay.addEventListener('focus', () => shareLinkDisplay.select());
  shareLinkDisplay.addEventListener('click', () => shareLinkDisplay.select());

  copyLinkBtn.addEventListener('click', () => {
    const original = copyLinkBtn.textContent;
    Promise.resolve(copyToClipboard(shareUrl())).then((result) => {
      const failed = result === false;
      copyLinkBtn.textContent = failed ? 'Não foi possível copiar' : 'Link copiado!';
      setTimeout(() => (copyLinkBtn.textContent = original), 1800);
    });
  });

  document.querySelectorAll('.ticket-row.has-resumo').forEach((row) => {
    row.addEventListener('click', () => {
      const panel = document.getElementById(row.dataset.target);
      const btn = row.querySelector('.expand-btn');
      const isHidden = panel.hidden;
      panel.hidden = !isHidden;
      panel.style.display = isHidden ? '' : 'none';
      btn.setAttribute('aria-expanded', String(isHidden));
      btn.firstChild.textContent = isHidden ? 'Ocultar ' : 'Ver ';
    });
  });

  const initialParams = new URL(window.location.href).searchParams;
  const initialEmpresa = initialParams.get('empresa');
  if (initialEmpresa) setEmpresaFilter(initialEmpresa, true);
  const initialTecnicos = initialParams.getAll('tecnico');
  if (initialTecnicos.length) setTecnicoFilter(initialTecnicos, true);
  const initialInicio = initialParams.get('inicio');
  const initialFim = initialParams.get('fim');
  if (initialInicio || initialFim) setPeriodoFilter(initialInicio, initialFim, true);
</script>
`;
}

async function main() {
  const { all, days, since, until, out, otrs, publicUrl, usersFile, noAuth, panel } = parseArgs(process.argv.slice(2));
  // Falha antes de consultar o Bitrix24: o relatório só sai sem senha se isso for pedido explicitamente.
  const credentials = noAuth ? [] : loadCredentials({ usersFile });
  if (!noAuth && !credentials.length) {
    throw new Error(
      'Nenhuma credencial configurada. Defina B24_REPORT_USERS="usuario:senha,..." ou B24_REPORT_USERS_FILE / --users-file=<arquivo> ' +
        '(uma linha usuario:senha por usuário). Use --no-auth para gerar o relatório sem proteção.'
    );
  }
  if (all) {
    console.log('Coletando todo o histórico de tickets do Help Desk...');
  } else if (since || until) {
    console.log(`Coletando dados do Help Desk de ${since || '(início)'} até ${until || '(hoje)'}...`);
  } else {
    console.log(`Coletando dados do Help Desk dos últimos ${days} dias...`);
  }
  if (otrs && fs.existsSync(otrs)) console.log(`Mesclando chamados externos (OTRS): ${otrs}`);
  const data = await collectHelpDeskReportData({ all, days, since, until, otrsPath: otrs });
  const report = renderHelpDeskReportHtml({ ...data, publicUrl });
  const html = noAuth ? report : protectHtml(report, credentials, { title: 'Relatório Help Desk' });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  const access = panel ? 'acesso pelo painel /reports' : noAuth ? 'SEM proteção por senha' : `protegido para ${credentials.length} usuário(s)`;
  console.log(`Relatório gerado: ${out} (${data.rows.length} tickets, ${access})`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
