import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createReportUserStore } from './report-users.js';

let filePath;
beforeEach(() => {
  filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'report-users-')), 'users.json');
});

describe('report user store', () => {
  it('seeds admin/admin with a mandatory password change on first run, without storing the password in clear', () => {
    const store = createReportUserStore({ filePath });
    expect(store.authenticate('admin', 'admin')).toEqual({ username: 'admin', role: 'admin', mustChangePassword: true });
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).admin.passwordHash).toMatch(/^scrypt\$/);
  });

  it('does not re-seed admin once the file exists', () => {
    const store = createReportUserStore({ filePath });
    store.changePassword('admin', 'admin', 'nova-senha-1');
    const again = createReportUserStore({ filePath });
    expect(again.authenticate('admin', 'admin')).toBeNull();
    expect(again.authenticate('ADMIN', 'nova-senha-1')).toMatchObject({ username: 'admin', mustChangePassword: false });
  });

  it('rejects a wrong current password, a short password and reusing the current one', () => {
    const store = createReportUserStore({ filePath });
    expect(() => store.changePassword('admin', 'errada', 'nova-senha-1')).toThrow(/atual/);
    expect(() => store.changePassword('admin', 'admin', 'curta')).toThrow(/8 caracteres/);
    expect(() => store.changePassword('admin', 'admin', 'admin')).toThrow();
  });

  it('creates users that must change the initial password, and refuses duplicates or invalid names', () => {
    const store = createReportUserStore({ filePath });
    expect(store.create({ username: 'Maria', password: 'inicial-123' })).toEqual({ username: 'maria', role: 'viewer', mustChangePassword: true });
    expect(store.authenticate('maria', 'inicial-123')).not.toBeNull();
    expect(() => store.create({ username: 'maria', password: 'outra-senha' })).toThrow(/já existe/);
    expect(() => store.create({ username: 'a b', password: 'outra-senha' })).toThrow(/inválido/);
    expect(() => store.create({ username: 'x1', password: 'outra-senha', role: 'root' })).toThrow(/Perfil/);
  });

  it('resets a password forcing a new change, and never removes the last admin', () => {
    const store = createReportUserStore({ filePath });
    store.create({ username: 'joao', password: 'inicial-123' });
    store.changePassword('joao', 'inicial-123', 'minha-senha');
    store.resetPassword('joao', 'temporaria-1');
    expect(store.authenticate('joao', 'temporaria-1')).toMatchObject({ mustChangePassword: true });
    expect(() => store.remove('admin')).toThrow(/último administrador/);
    store.remove('joao');
    expect(store.get('joao')).toBeNull();
  });
});
