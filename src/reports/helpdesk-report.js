import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Bitrix24Client } from '../bitrix24/client.js';
import { resolveWebhook } from '../utils/resolve-webhook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HELP_DESK_CATEGORY_ID = 36; // Pipeline "Help Desk" no funil de negócios (crm.dealcategory.list)

const STATUS_LABEL = { 1: 'Nova', 2: 'Aguardando execução', 3: 'Em execução', 4: 'Aguardando controle', 5: 'Concluída', 6: 'Adiada', 7: 'Recusada' };

function parseArgs(argv) {
  const args = { days: 30, out: path.join(__dirname, '..', '..', 'reports', 'helpdesk-report.html') };
  for (const a of argv) {
    const [k, v] = a.replace(/^--/, '').split('=');
    if (k === 'days') args.days = Number(v);
    if (k === 'out') args.out = v;
  }
  return args;
}

async function fetchAllTasks(client, sinceIso) {
  let start = 0;
  const all = [];
  while (true) {
    const res = await client.call('tasks.task.list', {
      filter: { '%TITLE': 'ticket', '>=CREATED_DATE': sinceIso },
      select: ['ID', 'TITLE', 'DESCRIPTION', 'STATUS', 'CREATED_DATE', 'CHAT_ID', 'CLOSED_BY'],
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
    empresa: cleanEmpresa(empresa),
    problema: (problema || d.slice(0, 200)).trim() || '—',
    categoria: (categoria || '—').trim(),
    prioridade: cleanPrioridade(prioridadeRaw),
    statusResumo,
    resumoStatus: textoResumo,
    tecnico: tecnico || null,
  };
}

export async function collectHelpDeskReportData({ days = 30 } = {}) {
  const client = new Bitrix24Client(resolveWebhook());
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString().slice(0, 19);

  const tasks = await fetchAllTasks(client, sinceIso);

  const statusSummaries = {};
  for (const t of tasks) {
    statusSummaries[t.id] = await fetchStatusSummary(client, t.chatId);
  }

  const userIds = [...new Set(tasks.map((t) => t.closedBy).filter(Boolean))];
  const users = await fetchUsers(client, userIds);

  const rows = tasks
    .map((t) => buildRow(t, statusSummaries[t.id], t.closedBy ? users[t.closedBy] || `Usuário ${t.closedBy}` : null))
    .sort((a, b) => new Date(a.created) - new Date(b.created));

  return { rows, since, days, generatedAt: new Date(), portal: client.portal, categoryId: HELP_DESK_CATEGORY_ID };
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

const STATUS_CLASS = { Concluída: 'st-done', 'Em execução': 'st-progress', 'Aguardando execução': 'st-pending' };
const PRIO_CLASS = { Alta: 'p-alta', Emergencial: 'p-emerg', Normal: 'p-normal', '—': 'p-none' };

export function renderHelpDeskReportHtml({ rows, since, days, generatedAt }) {
  const total = rows.length;
  const comResumo = rows.filter((r) => r.resumoStatus).length;

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
      return `<div class="prio-row">
    <span class="prio-label ${PRIO_CLASS[p]}">${esc(p)}</span>
    <div class="prio-track"><div class="prio-fill ${PRIO_CLASS[p]}" style="width:${pct}%"></div></div>
    <span class="prio-count">${byPrio[p]}</span>
  </div>`;
    })
    .join('');

  const tecnicoBars = tecnicoOrder
    .map((t) => {
      const pct = Math.round((byTecnico[t] / maxTecnico) * 100);
      const cls = t === 'Sem técnico' ? 'p-none' : 'p-tecnico';
      return `<div class="prio-row">
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
        <tr data-status="${esc(r.status)}" data-empresa="${esc(r.empresa)}" class="ticket-row ${hasResumo ? 'has-resumo' : ''}" data-target="${rowId}">
          <td class="col-ticket"><span class="ticket-id">${esc(r.titulo.split(' - ')[0])}</span><span class="ticket-date">${fmtDate(r.created)}</span></td>
          <td class="col-empresa">${esc(r.empresa)}</td>
          <td class="col-resumo">${esc(r.problema)}</td>
          <td class="col-categoria">${esc(r.categoria)}</td>
          <td class="col-prioridade"><span class="prio ${PRIO_CLASS[r.prioridade] || 'p-none'}">${esc(r.prioridade)}</span></td>
          <td class="col-status"><span class="status ${STATUS_CLASS[r.status] || ''}">${esc(r.status)}</span></td>
          <td class="col-tecnico">${r.tecnico ? esc(r.tecnico) : '<span class="no-resumo">—</span>'}</td>
          <td class="col-expand">${hasResumo ? `<button class="expand-btn" aria-expanded="false" aria-controls="${rowId}">Ver <span class="chevron">▾</span></button>` : `<span class="no-resumo">—</span>`}</td>
        </tr>${
          hasResumo
            ? `
        <tr class="resumo-row" id="${rowId}" hidden>
          <td></td>
          <td colspan="7">
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

  const period = `${since.toLocaleDateString('pt-BR')} a ${generatedAt.toLocaleDateString('pt-BR')}`;

  return `<title>Relatório Help Desk — ${days} dias</title>
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
  .stat-card { background: var(--paper-raised); border: 1px solid var(--line); border-radius: 6px; padding: 1.1rem 1.25rem; }
  .stat-card h2 { font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-faint); margin: 0 0 0.75rem; font-weight: 500; }
  .stat-card .stat-note { font-size: 0.78rem; color: var(--ink-soft); margin: 0.6rem 0 0; }

  .prio-row { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.5rem; }
  .prio-row:last-child { margin-bottom: 0; }
  .prio-label { font-family: var(--mono); font-size: 0.72rem; width: 5.4rem; flex-shrink: 0; }
  .prio-track { flex: 1; height: 7px; background: var(--paper); border-radius: 4px; overflow: hidden; }
  .prio-fill { height: 100%; border-radius: 4px; }
  .prio-count { font-family: var(--mono); font-size: 0.78rem; color: var(--ink-soft); width: 1.6rem; text-align: right; font-variant-numeric: tabular-nums; }
  .p-alta, .prio-fill.p-alta { color: var(--accent); background: var(--accent); }
  .p-emerg, .prio-fill.p-emerg { color: #b03a2e; background: #b03a2e; }
  .p-normal, .prio-fill.p-normal { color: var(--busy); background: var(--busy); }
  .p-none, .prio-fill.p-none { color: var(--ink-faint); background: var(--ink-faint); }
  .prio-fill.p-tecnico { background: var(--good); }
  .tecnico-label { width: 9.5rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

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
  .share-link-row { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.5rem; }
  .share-link-row button {
    font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.04em; text-transform: uppercase;
    background: var(--good-soft); color: var(--good); border: none; border-radius: 4px; padding: 0.4rem 0.6rem; cursor: pointer; white-space: nowrap;
  }
  .share-link-row button:disabled { opacity: 0.4; cursor: not-allowed; }
  .share-hint { font-size: 0.72rem; color: var(--ink-faint); margin: 0; }

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
  .ticket-id { display: block; font-size: 0.78rem; color: var(--ink); }
  .ticket-date { display: block; font-size: 0.68rem; color: var(--ink-faint); margin-top: 0.1rem; }
  .col-empresa { max-width: 180px; font-weight: 600; }
  .col-resumo { max-width: 300px; color: var(--ink-soft); }
  .col-categoria { max-width: 150px; font-family: var(--mono); font-size: 0.76rem; color: var(--ink-soft); }
  .col-prioridade, .col-status, .col-expand { white-space: nowrap; }
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
      <h1>Relatório de tickets — ${days} dias</h1>
      <p class="subtitle">${esc(period)} · tarefas do módulo Tasks vinculadas aos negócios da categoria Help Desk</p>
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
      <h2>Por técnico</h2>
      ${tecnicoBars}
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
          <th>Técnico</th>
          <th>Resumo</th>
        </tr>
      </thead>
      <tbody>${tableRows}
      </tbody>
    </table>
  </div>

  <footer class="report-foot">
    <span>Fonte: tasks.task.list (CLOSED_BY = técnico) + im.dialog.messages.get (resumo de status) — filtro %TITLE=ticket, CREATED_DATE ≥ ${since.toISOString().slice(0, 10)}</span>
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
  const clientBanner = document.getElementById('client-banner');
  const clientBannerName = document.getElementById('client-banner-name');
  const clientBannerClear = document.getElementById('client-banner-clear');
  const TOTAL = ${total};

  let statusFilter = 'all';
  let empresaFilter = '';

  function applyFilters() {
    let shown = 0;
    ticketRows.forEach((r) => {
      const matchStatus = statusFilter === 'all' || r.dataset.status === statusFilter;
      const matchEmpresa = !empresaFilter || r.dataset.empresa.toLowerCase() === empresaFilter.toLowerCase();
      const match = matchStatus && matchEmpresa;
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
    } else {
      copyLinkBtn.disabled = true;
      shareHint.textContent = 'Escolha um cliente para gerar um link só com os tickets dele.';
      clientBanner.classList.remove('active');
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

  copyLinkBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      const original = copyLinkBtn.textContent;
      copyLinkBtn.textContent = 'Link copiado!';
      setTimeout(() => (copyLinkBtn.textContent = original), 1500);
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

  const initialEmpresa = new URL(window.location.href).searchParams.get('empresa');
  if (initialEmpresa) setEmpresaFilter(initialEmpresa, true);
</script>
`;
}

async function main() {
  const { days, out } = parseArgs(process.argv.slice(2));
  console.log(`Coletando dados do Help Desk dos últimos ${days} dias...`);
  const data = await collectHelpDeskReportData({ days });
  const html = renderHelpDeskReportHtml(data);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`Relatório gerado: ${out} (${data.rows.length} tickets)`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
