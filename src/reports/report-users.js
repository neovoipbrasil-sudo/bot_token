import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import crypto from 'crypto';
import path from 'path';

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;
export const MIN_PASSWORD_LENGTH = 8;
const USERNAME_RE = /^[a-z0-9._-]{2,32}$/;

// Hash vazio usado quando o usuário não existe, para o login levar o mesmo
// tempo e não revelar pelo tempo de resposta quais usuários estão cadastrados.
const DUMMY_HASH = hashPassword('dummy-password');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function checkPassword(password, stored) {
  const [, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

export function normalizeUsername(username) {
  return String(username ?? '').trim().toLowerCase();
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  }
}

// Usuários do painel de relatórios, guardados num JSON no volume persistente do bot.
// Na primeira execução (arquivo inexistente) cria admin/admin, com troca de senha
// obrigatória no primeiro login.
export function createReportUserStore({ filePath }) {
  function load() {
    if (!existsSync(filePath)) {
      const seeded = { admin: { role: 'admin', passwordHash: hashPassword('admin'), mustChangePassword: true } };
      persist(seeded);
      return seeded;
    }
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  }

  function persist(data) {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Grava num arquivo temporário e renomeia, para um crash no meio não deixar o JSON truncado.
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, filePath);
  }

  function publicView(username, u) {
    return { username, role: u.role, mustChangePassword: !!u.mustChangePassword };
  }

  load();

  return {
    // Retorna o usuário (sem o hash) se a senha confere, ou null.
    authenticate(username, password) {
      const name = normalizeUsername(username);
      const u = load()[name];
      const ok = checkPassword(String(password ?? ''), u?.passwordHash ?? DUMMY_HASH);
      return u && ok ? publicView(name, u) : null;
    },

    get(username) {
      const name = normalizeUsername(username);
      const u = load()[name];
      return u ? publicView(name, u) : null;
    },

    list() {
      return Object.entries(load())
        .map(([name, u]) => publicView(name, u))
        .sort((a, b) => a.username.localeCompare(b.username));
    },

    create({ username, password, role = 'viewer' }) {
      const name = normalizeUsername(username);
      if (!USERNAME_RE.test(name)) {
        throw new Error('Usuário inválido: use de 2 a 32 caracteres entre letras minúsculas, números, ".", "_" e "-".');
      }
      if (!['admin', 'viewer'].includes(role)) throw new Error('Perfil inválido.');
      validatePassword(password);
      const data = load();
      if (data[name]) throw new Error(`O usuário "${name}" já existe.`);
      // A senha inicial é definida pelo admin, então o próprio usuário troca no primeiro acesso.
      data[name] = { role, passwordHash: hashPassword(password), mustChangePassword: true };
      persist(data);
      return publicView(name, data[name]);
    },

    // Troca feita pelo próprio usuário: exige a senha atual e libera o acesso.
    changePassword(username, currentPassword, newPassword) {
      const name = normalizeUsername(username);
      const data = load();
      const u = data[name];
      if (!u || !checkPassword(String(currentPassword ?? ''), u.passwordHash)) throw new Error('A senha atual está incorreta.');
      validatePassword(newPassword);
      if (checkPassword(newPassword, u.passwordHash)) throw new Error('A nova senha precisa ser diferente da atual.');
      u.passwordHash = hashPassword(newPassword);
      u.mustChangePassword = false;
      persist(data);
    },

    // Redefinição feita por um admin: o usuário terá de trocar a senha no próximo login.
    resetPassword(username, newPassword) {
      const name = normalizeUsername(username);
      const data = load();
      if (!data[name]) throw new Error(`O usuário "${name}" não existe.`);
      validatePassword(newPassword);
      data[name].passwordHash = hashPassword(newPassword);
      data[name].mustChangePassword = true;
      persist(data);
    },

    remove(username) {
      const name = normalizeUsername(username);
      const data = load();
      if (!data[name]) throw new Error(`O usuário "${name}" não existe.`);
      const admins = Object.values(data).filter((u) => u.role === 'admin');
      if (data[name].role === 'admin' && admins.length === 1) throw new Error('Não é possível remover o último administrador.');
      delete data[name];
      persist(data);
    },
  };
}
