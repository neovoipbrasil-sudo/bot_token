import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { MIN_PASSWORD_LENGTH, normalizeUsername } from './report-users.js';

const COOKIE = 'rp_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const REPORT_FILE_RE = /^[\w.-]+\.html$/;

const MESSAGES = {
  'senha-alterada': 'Senha alterada.',
  'usuario-criado': 'Usuário criado. Ele vai definir a própria senha no primeiro acesso.',
  'usuario-removido': 'Usuário removido.',
  'senha-redefinida': 'Senha redefinida. O usuário vai trocá-la no próximo acesso.',
};

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Só aceita voltar para páginas do próprio painel, nunca para outro host ("//evil.com").
function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/reports/') && !next.startsWith('//') ? next : '/reports/';
}

function page({ title, user, body }) {
  const nav = user
    ? `<nav><a href="/reports/">Relatórios</a>${user.role === 'admin' ? '<a href="/reports/usuarios">Usuários</a>' : ''}<a href="/reports/senha">Trocar senha</a>
      <form method="post" action="/reports/sair"><button class="link">Sair (${esc(user.username)})</button></form></nav>`
    : '';
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root {
    --paper: #eef1ee; --paper-raised: #ffffff; --ink: #12181a; --ink-soft: #4a5559; --ink-faint: #7c8a8d;
    --line: #d4dad5; --accent: #d9622b; --danger: #b03a2e; --good: #2f7d5c; --good-soft: #e1f0e8; --busy: #3b6ea5;
    --mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
    --sans: ui-sans-serif, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --serif: Georgia, "Iowan Old Style", "Palatino Linotype", serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #10161a; --paper-raised: #171f24; --ink: #e9edee; --ink-soft: #a9b4b6; --ink-faint: #6c797c;
      --line: #2a3438; --accent: #ef7f42; --danger: #e8806f; --good: #5cbd91; --good-soft: #16261e; --busy: #7fb0e0;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--sans); line-height: 1.45; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 2rem 1rem 4rem; }
  .narrow { max-width: 380px; }
  nav { display: flex; flex-wrap: wrap; gap: 0.4rem 1.2rem; align-items: center; font-family: var(--mono); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; padding-bottom: 1rem; border-bottom: 1px solid var(--line); margin-bottom: 1.75rem; }
  nav form { margin: 0 0 0 auto; }
  a { color: var(--busy); }
  .eyebrow { font-family: var(--mono); font-size: 0.7rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); margin: 0 0 0.5rem; }
  h1 { font-family: var(--serif); font-weight: 400; font-size: 1.7rem; margin: 0 0 1rem; }
  h2 { font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-faint); font-weight: 500; margin: 2rem 0 0.75rem; }
  .card { background: var(--paper-raised); border: 1px solid var(--line); border-radius: 6px; padding: 1.25rem; }
  label { display: flex; flex-direction: column; gap: 0.3rem; font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-faint); margin-bottom: 0.9rem; }
  input, select { font-family: var(--sans); font-size: 1rem; padding: 0.5rem 0.7rem; border: 1px solid var(--line); border-radius: 6px; background: var(--paper); color: var(--ink); width: 100%; }
  input:focus, select:focus { outline: 2px solid var(--busy); outline-offset: 1px; }
  button { font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.06em; text-transform: uppercase; padding: 0.65rem 1rem; border: none; border-radius: 6px; background: var(--ink); color: var(--paper-raised); cursor: pointer; }
  button.full { width: 100%; }
  button.small { padding: 0.35rem 0.6rem; font-size: 0.65rem; background: var(--paper); color: var(--ink-soft); border: 1px solid var(--line); }
  button.danger { color: var(--danger); }
  button.link { background: none; color: var(--busy); padding: 0; font-size: 0.75rem; text-decoration: underline; }
  .hint { font-size: 0.85rem; color: var(--ink-soft); margin: 0 0 1.25rem; }
  .error, .ok { font-size: 0.85rem; padding: 0.6rem 0.8rem; border-radius: 6px; margin: 0 0 1rem; }
  .error { color: var(--danger); border: 1px solid var(--danger); }
  .ok { color: var(--good); background: var(--good-soft); }
  ul.reports { list-style: none; padding: 0; margin: 0; }
  ul.reports li { padding: 0.75rem 0; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
  ul.reports li:last-child { border-bottom: none; }
  .meta { font-family: var(--mono); font-size: 0.72rem; color: var(--ink-faint); }
  .users { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  .users td { padding: 0.6rem 0.4rem; border-bottom: 1px solid var(--line); vertical-align: middle; }
  .users tr:last-child td { border-bottom: none; }
  .users .actions { display: flex; gap: 0.4rem; flex-wrap: wrap; justify-content: flex-end; }
  .users .actions form { display: flex; gap: 0.4rem; margin: 0; }
  .users .actions input { width: 9rem; font-size: 0.8rem; padding: 0.3rem 0.5rem; }
  .tag { white-space: nowrap; font-family: var(--mono); font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.1rem 0.4rem; border-radius: 3px; border: 1px solid var(--line); color: var(--ink-soft); margin-left: 0.4rem; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 0 0.8rem; }
  @media (max-width: 560px) {
    .row { grid-template-columns: 1fr; }
    .users tr, .users td { display: block; }
    .users td { border-bottom: none; padding: 0.3rem 0; }
    .users tr { padding: 0.6rem 0; border-bottom: 1px solid var(--line); }
    .users tr:last-child { border-bottom: none; }
    .users .actions { justify-content: flex-start; }
    .users .actions form { flex: 1 1 100%; }
    .users .actions input { flex: 1; width: auto; min-width: 0; }
  }
</style>
</head>
<body><div class="wrap">${nav}${body}</div></body>
</html>`;
}

// Painel de relatórios protegido por usuário e senha. Os relatórios são arquivos .html
// em reportsDir (gerados com --no-auth, já que quem protege o acesso é o próprio painel).
export function createReportsPanel({ userStore, reportsDir, now = () => Date.now() }) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

  const sessions = new Map(); // token -> { username, expires }
  // Por IP + usuário: atrás do proxy reverso todos podem chegar com o mesmo IP, e contar só
  // por IP deixaria um atacante bloquear o login de todo mundo.
  const failures = new Map(); // `${ip}|${usuario}` -> { count, since }

  function setCookie(req, res, value, maxAgeMs) {
    const secure = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : '';
    res.append('Set-Cookie', `${COOKIE}=${value}; Path=/reports; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`);
  }

  function currentUser(req) {
    const token = parseCookies(req.get('cookie'))[COOKIE];
    const s = token && sessions.get(token);
    if (!s) return null;
    if (s.expires < now()) {
      sessions.delete(token);
      return null;
    }
    // Relê do armazenamento a cada request: usuário removido ou com senha redefinida perde o acesso na hora.
    const user = userStore.get(s.username);
    if (!user) sessions.delete(token);
    return user ? { ...user, token } : null;
  }

  function endSessionsOf(username, exceptToken) {
    const name = normalizeUsername(username);
    for (const [token, s] of sessions) if (s.username === name && token !== exceptToken) sessions.delete(token);
  }

  function isBlocked(key) {
    const f = failures.get(key);
    if (!f) return false;
    if (now() - f.since > FAILURE_WINDOW_MS) {
      failures.delete(key);
      return false;
    }
    return f.count >= MAX_FAILURES;
  }

  function recordFailure(key) {
    const f = failures.get(key);
    if (!f || now() - f.since > FAILURE_WINDOW_MS) failures.set(key, { count: 1, since: now() });
    else f.count++;
  }

  // Proteção contra CSRF além do SameSite=Strict: um POST vindo de outra origem é recusado.
  router.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const origin = req.get('origin');
    if (origin) {
      let host;
      try {
        host = new URL(origin).host;
      } catch {
        host = null;
      }
      if (host !== req.get('host')) return res.status(403).send('forbidden');
    }
    next();
  });

  function loginPage(res, { error, next, status = 200 } = {}) {
    res.status(status).send(
      page({
        title: 'Entrar — Relatórios',
        body: `<div class="narrow">
  <p class="eyebrow">Acesso restrito</p>
  <h1>Relatórios</h1>
  ${error ? `<p class="error" role="alert">${esc(error)}</p>` : '<p class="hint">Entre com seu usuário e senha.</p>'}
  <form method="post" action="/reports/login" class="card">
    <input type="hidden" name="next" value="${esc(next || '')}">
    <label>Usuário <input name="username" autocomplete="username" required autofocus></label>
    <label>Senha <input name="password" type="password" autocomplete="current-password" required></label>
    <button class="full">Entrar</button>
  </form>
</div>`,
      })
    );
  }

  router.get('/login', (req, res) => {
    if (currentUser(req)) return res.redirect(safeNext(req.query.next));
    loginPage(res, { next: req.query.next });
  });

  router.post('/login', (req, res) => {
    const key = req.ip + '|' + normalizeUsername(req.body?.username);
    const next = req.body?.next;
    if (isBlocked(key)) return loginPage(res, { status: 429, next, error: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' });
    const user = userStore.authenticate(req.body?.username, req.body?.password);
    if (!user) {
      recordFailure(key);
      return loginPage(res, { status: 401, next, error: 'Usuário ou senha incorretos.' });
    }
    failures.delete(key);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { username: user.username, expires: now() + SESSION_TTL_MS });
    setCookie(req, res, token, SESSION_TTL_MS);
    res.redirect(user.mustChangePassword ? '/reports/senha' : safeNext(next));
  });

  router.post('/sair', (req, res) => {
    const token = parseCookies(req.get('cookie'))[COOKIE];
    if (token) sessions.delete(token);
    setCookie(req, res, '', 0);
    res.redirect('/reports/login');
  });

  // Daqui para baixo tudo exige login; com troca de senha pendente, só a página de senha fica liberada.
  router.use((req, res, next) => {
    const user = currentUser(req);
    if (!user) return res.redirect('/reports/login?next=' + encodeURIComponent(req.originalUrl));
    if (user.mustChangePassword && req.path !== '/senha') return res.redirect('/reports/senha');
    req.reportUser = user;
    res.set('Cache-Control', 'no-store');
    next();
  });

  function passwordPage(req, res, { error, status = 200 } = {}) {
    const user = req.reportUser;
    res.status(status).send(
      page({
        title: 'Trocar senha — Relatórios',
        user: user.mustChangePassword ? null : user,
        body: `<div class="narrow">
  <p class="eyebrow">${user.mustChangePassword ? 'Primeiro acesso' : 'Conta'}</p>
  <h1>Trocar senha</h1>
  ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
  ${user.mustChangePassword ? `<p class="hint">Antes de continuar, defina uma senha nova para <b>${esc(user.username)}</b>.</p>` : ''}
  <form method="post" action="/reports/senha" class="card">
    <input type="hidden" name="username" value="${esc(user.username)}" autocomplete="username">
    <label>Senha atual <input name="current" type="password" autocomplete="current-password" required></label>
    <label>Nova senha <input name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required></label>
    <label>Repita a nova senha <input name="confirm" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required></label>
    <button class="full">Salvar senha</button>
  </form>
  ${user.mustChangePassword ? '<form method="post" action="/reports/sair" style="margin-top:1rem"><button class="link">Sair</button></form>' : ''}
</div>`,
      })
    );
  }

  router.get('/senha', (req, res) => passwordPage(req, res));

  router.post('/senha', (req, res) => {
    const { current, password, confirm } = req.body ?? {};
    if (password !== confirm) return passwordPage(req, res, { status: 400, error: 'As duas senhas novas não são iguais.' });
    try {
      userStore.changePassword(req.reportUser.username, current, password);
    } catch (err) {
      return passwordPage(req, res, { status: 400, error: err.message });
    }
    // Quem souber a senha antiga perde as sessões abertas; a sessão atual continua.
    endSessionsOf(req.reportUser.username, req.reportUser.token);
    res.redirect('/reports/?msg=senha-alterada');
  });

  function listReports() {
    if (!fs.existsSync(reportsDir)) return [];
    return fs
      .readdirSync(reportsDir)
      .filter((f) => REPORT_FILE_RE.test(f))
      .map((f) => ({ file: f, mtime: fs.statSync(path.join(reportsDir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);
  }

  router.get('/', (req, res) => {
    const reports = listReports();
    const msg = MESSAGES[req.query.msg];
    const items = reports
      .map(
        (r) => `<li><a href="/reports/ver/${encodeURIComponent(r.file)}">${esc(r.file.replace(/\.html$/, ''))}</a>
        <span class="meta">atualizado em ${esc(r.mtime.toLocaleString('pt-BR'))}</span></li>`
      )
      .join('');
    res.send(
      page({
        title: 'Relatórios',
        user: req.reportUser,
        body: `<p class="eyebrow">Neo Voip · Bitrix24</p>
  <h1>Relatórios</h1>
  ${msg ? `<p class="ok">${esc(msg)}</p>` : ''}
  <div class="card">${items ? `<ul class="reports">${items}</ul>` : '<p class="hint" style="margin:0">Nenhum relatório gerado ainda.</p>'}</div>`,
      })
    );
  });

  router.get('/ver/:file', (req, res) => {
    const file = req.params.file;
    if (!REPORT_FILE_RE.test(file)) return res.status(404).send('not found');
    if (!fs.existsSync(path.join(reportsDir, file))) return res.status(404).send('not found');
    // Com root, o send só aplica a regra de "dotfiles" ao nome do arquivo, não ao caminho do diretório
    // (sem isso, um REPORTS_DIR dentro de uma pasta como ".config" daria 404).
    res.sendFile(file, { root: path.resolve(reportsDir) });
  });

  // --- Administração de usuários ---
  router.use('/usuarios', (req, res, next) => {
    if (req.reportUser.role !== 'admin') return res.status(403).send(page({ title: 'Acesso negado', user: req.reportUser, body: '<h1>Acesso negado</h1><p class="hint">Só administradores gerenciam usuários.</p>' }));
    next();
  });

  function usersPage(req, res, { error, status = 200 } = {}) {
    const me = req.reportUser.username;
    const msg = MESSAGES[req.query.msg];
    const rows = userStore
      .list()
      .map(
        (u) => `<tr>
      <td><b>${esc(u.username)}</b><span class="tag">${u.role === 'admin' ? 'admin' : 'leitura'}</span>${u.mustChangePassword ? '<span class="tag">troca pendente</span>' : ''}</td>
      <td><div class="actions">
        <form method="post" action="/reports/usuarios/${encodeURIComponent(u.username)}/redefinir">
          <input name="password" type="password" placeholder="Nova senha" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required aria-label="Nova senha para ${esc(u.username)}">
          <button class="small">Redefinir</button>
        </form>
        ${u.username === me ? '' : `<form method="post" action="/reports/usuarios/${encodeURIComponent(u.username)}/remover" onsubmit="return confirm('Remover ${esc(u.username)}?')"><button class="small danger">Remover</button></form>`}
      </div></td>
    </tr>`
      )
      .join('');
    res.status(status).send(
      page({
        title: 'Usuários — Relatórios',
        user: req.reportUser,
        body: `<p class="eyebrow">Administração</p>
  <h1>Usuários</h1>
  ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
  ${msg ? `<p class="ok">${esc(msg)}</p>` : ''}
  <div class="card"><table class="users"><tbody>${rows}</tbody></table></div>
  <h2>Novo usuário</h2>
  <form method="post" action="/reports/usuarios" class="card">
    <div class="row">
      <label>Usuário <input name="username" autocomplete="off" pattern="[a-zA-Z0-9._\\-]{2,32}" required></label>
      <label>Perfil <select name="role"><option value="viewer">Leitura (só relatórios)</option><option value="admin">Administrador</option></select></label>
    </div>
    <label>Senha inicial <input name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required></label>
    <p class="hint">O usuário vai trocar essa senha no primeiro acesso.</p>
    <button>Criar usuário</button>
  </form>`,
      })
    );
  }

  router.get('/usuarios', (req, res) => usersPage(req, res));

  router.post('/usuarios', (req, res) => {
    try {
      userStore.create({ username: req.body?.username, password: req.body?.password, role: req.body?.role });
    } catch (err) {
      return usersPage(req, res, { status: 400, error: err.message });
    }
    res.redirect('/reports/usuarios?msg=usuario-criado');
  });

  router.post('/usuarios/:username/redefinir', (req, res) => {
    try {
      userStore.resetPassword(req.params.username, req.body?.password);
    } catch (err) {
      return usersPage(req, res, { status: 400, error: err.message });
    }
    endSessionsOf(req.params.username, req.reportUser.token);
    // Se o admin redefiniu a própria senha, a sessão dele cai na tela de troca obrigatória.
    res.redirect('/reports/usuarios?msg=senha-redefinida');
  });

  router.post('/usuarios/:username/remover', (req, res) => {
    if (normalizeUsername(req.params.username) === req.reportUser.username) return usersPage(req, res, { status: 400, error: 'Você não pode remover o próprio usuário.' });
    try {
      userStore.remove(req.params.username);
    } catch (err) {
      return usersPage(req, res, { status: 400, error: err.message });
    }
    endSessionsOf(req.params.username);
    res.redirect('/reports/usuarios?msg=usuario-removido');
  });

  return router;
}
