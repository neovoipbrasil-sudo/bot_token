import crypto from 'crypto';
import fs from 'fs';
import zlib from 'zlib';

// Recomendação OWASP (2023) para PBKDF2-HMAC-SHA256.
export const PBKDF2_ITERATIONS = 600_000;
const USER_ID_PREFIX = 'helpdesk-report:';

// Aceita "usuario:senha" separados por vírgula (variável de ambiente) ou por linha (arquivo).
// A senha vai até o fim do item, então pode conter ":"; linhas iniciadas por "#" são comentários.
export function parseCredentials(text) {
  if (!text) return [];
  const items = String(text)
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
  const seen = new Set();
  return items.map((item) => {
    const sep = item.indexOf(':');
    const user = sep > 0 ? item.slice(0, sep).trim() : '';
    const password = sep > 0 ? item.slice(sep + 1) : '';
    if (!user || !password) throw new Error(`Credencial inválida: "${item.split(':')[0]}". Use o formato usuario:senha.`);
    const norm = user.toLowerCase();
    if (seen.has(norm)) throw new Error(`Usuário duplicado nas credenciais: "${user}".`);
    seen.add(norm);
    return { user, password };
  });
}

// Lê as credenciais de --users-file, B24_REPORT_USERS_FILE ou B24_REPORT_USERS, nessa ordem.
export function loadCredentials({ usersFile, env = process.env } = {}) {
  const file = usersFile || env.B24_REPORT_USERS_FILE;
  if (file) return parseCredentials(fs.readFileSync(file, 'utf8'));
  return parseCredentials(env.B24_REPORT_USERS);
}

function userId(user) {
  return crypto.createHash('sha256').update(USER_ID_PREFIX + user.trim().toLowerCase()).digest('hex');
}

function aesGcmEncrypt(key, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  // WebCrypto espera o tag de autenticação concatenado ao fim do ciphertext.
  const data = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString('base64'), data: data.toString('base64') };
}

// Cifra o HTML com uma chave aleatória (AES-256-GCM) e embrulha essa chave uma vez por usuário,
// com uma chave derivada da senha dele (PBKDF2). Sem uma credencial válida o conteúdo é ilegível.
export function encryptHtml(html, credentials, { iterations = PBKDF2_ITERATIONS } = {}) {
  if (!credentials?.length) throw new Error('Nenhuma credencial informada para proteger o relatório.');
  const dek = crypto.randomBytes(32);
  const content = aesGcmEncrypt(dek, zlib.gzipSync(Buffer.from(html, 'utf8')));
  const keys = {};
  for (const { user, password } of credentials) {
    const salt = crypto.randomBytes(16);
    const kek = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
    const wrapped = aesGcmEncrypt(kek, dek);
    keys[userId(user)] = { salt: salt.toString('base64'), iv: wrapped.iv, key: wrapped.data };
  }
  return { v: 1, iterations, iv: content.iv, data: content.data, keys };
}

// As funções abaixo rodam no navegador (são serializadas com toString() para dentro da página)
// e também nos testes, já que o Node expõe as mesmas APIs (crypto.subtle, DecompressionStream).
// Por isso não podem referenciar nada fora do próprio corpo.
export async function unlockReport(payload, user, password) {
  const enc = new TextEncoder();
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  const id = hex(await crypto.subtle.digest('SHA-256', enc.encode('helpdesk-report:' + user.trim().toLowerCase())));
  // Usuário inexistente ainda passa pelo PBKDF2, para não revelar quais usuários existem pelo tempo de resposta.
  const entry = payload.keys[id] || { salt: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: 'AAAAAAAAAAAAAAAA', key: '' };
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const kek = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64(entry.salt), iterations: payload.iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(entry.iv) }, kek, b64(entry.key)));
  } catch {
    return null;
  }
}

export async function openReport(payload, rawKey) {
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const gz = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(payload.iv) }, key, b64(payload.data));
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Gera a página de login com o relatório cifrado embutido. Após o login, a página substitui a si
// mesma pelo relatório (document.write), preservando a URL e, portanto, os filtros da query string.
export function protectHtml(html, credentials, { title = 'Acesso restrito', iterations } = {}) {
  const payload = encryptHtml('<!doctype html>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' + html, credentials, { iterations });
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root {
    --paper: #eef1ee; --paper-raised: #ffffff; --ink: #12181a; --ink-soft: #4a5559; --ink-faint: #7c8a8d;
    --line: #d4dad5; --accent: #d9622b; --danger: #b03a2e; --busy: #3b6ea5;
    --mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
    --sans: ui-sans-serif, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --serif: Georgia, "Iowan Old Style", "Palatino Linotype", serif;
  }
  :root[data-theme="dark"] {
    --paper: #10161a; --paper-raised: #171f24; --ink: #e9edee; --ink-soft: #a9b4b6; --ink-faint: #6c797c;
    --line: #2a3438; --accent: #ef7f42; --danger: #e8806f; --busy: #7fb0e0;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --paper: #10161a; --paper-raised: #171f24; --ink: #e9edee; --ink-soft: #a9b4b6; --ink-faint: #6c797c;
      --line: #2a3438; --accent: #ef7f42; --danger: #e8806f; --busy: #7fb0e0;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1rem; background: var(--paper); color: var(--ink); font-family: var(--sans); }
  .login { width: 100%; max-width: 360px; background: var(--paper-raised); border: 1px solid var(--line); border-radius: 6px; padding: 1.75rem 1.5rem; }
  .eyebrow { font-family: var(--mono); font-size: 0.7rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); margin: 0 0 0.5rem; }
  h1 { font-family: var(--serif); font-weight: 400; font-size: 1.6rem; margin: 0 0 0.4rem; }
  .hint { font-size: 0.85rem; color: var(--ink-soft); margin: 0 0 1.25rem; }
  label { display: flex; flex-direction: column; gap: 0.3rem; font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-faint); margin-bottom: 0.9rem; }
  input { font-family: var(--sans); font-size: 1rem; padding: 0.55rem 0.7rem; border: 1px solid var(--line); border-radius: 6px; background: var(--paper); color: var(--ink); width: 100%; }
  input:focus { outline: 2px solid var(--busy); outline-offset: 1px; }
  button { width: 100%; font-family: var(--mono); font-size: 0.75rem; letter-spacing: 0.06em; text-transform: uppercase; padding: 0.7rem; border: none; border-radius: 6px; background: var(--ink); color: var(--paper-raised); cursor: pointer; }
  button:disabled { opacity: 0.55; cursor: wait; }
  .error { min-height: 1.2rem; font-size: 0.82rem; color: var(--danger); margin: 0.75rem 0 0; }
</style>

<form class="login" id="login-form" autocomplete="on">
  <p class="eyebrow">Acesso restrito</p>
  <h1>${esc(title)}</h1>
  <p class="hint">Entre com seu usuário e senha para abrir o relatório.</p>
  <label>Usuário <input id="login-user" name="username" autocomplete="username" required autofocus /></label>
  <label>Senha <input id="login-pass" name="password" type="password" autocomplete="current-password" required /></label>
  <button id="login-btn" type="submit">Entrar</button>
  <p class="error" id="login-error" role="alert"></p>
</form>

<script type="application/json" id="report-payload">${JSON.stringify(payload)}</script>
<script>
  ${unlockReport.toString()}
  ${openReport.toString()}

  const payload = JSON.parse(document.getElementById('report-payload').textContent);
  // A chave do conteúdo fica só nesta aba (sessionStorage): recarregar não pede login de novo,
  // fechar a aba sim. O identificador muda a cada geração do relatório.
  const SESSION_KEY = 'report-key:' + payload.iv;
  const form = document.getElementById('login-form');
  const btn = document.getElementById('login-btn');
  const error = document.getElementById('login-error');

  async function show(rawKey) {
    const html = await openReport(payload, rawKey);
    try {
      sessionStorage.setItem(SESSION_KEY, btoa(String.fromCharCode(...rawKey)));
    } catch {}
    document.open();
    document.write(html);
    document.close();
  }

  (async () => {
    let saved = null;
    try {
      saved = sessionStorage.getItem(SESSION_KEY);
    } catch {}
    if (!saved) return;
    try {
      await show(Uint8Array.from(atob(saved), (c) => c.charCodeAt(0)));
    } catch {
      try { sessionStorage.removeItem(SESSION_KEY); } catch {}
    }
  })();

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Verificando…';
    try {
      if (!window.crypto || !crypto.subtle) throw new Error('Este navegador não suporta a descriptografia do relatório.');
      const rawKey = await unlockReport(payload, document.getElementById('login-user').value, document.getElementById('login-pass').value);
      if (!rawKey) {
        error.textContent = 'Usuário ou senha incorretos.';
        return;
      }
      await show(rawKey);
    } catch (err) {
      error.textContent = err.message || 'Não foi possível abrir o relatório.';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Entrar';
    }
  });
</script>
`;
}
