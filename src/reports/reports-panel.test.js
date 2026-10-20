import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createReportUserStore } from './report-users.js';
import { createReportsPanel } from './reports-panel.js';

let app, store, reportsDir;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-panel-'));
  reportsDir = path.join(dir, 'reports');
  fs.mkdirSync(reportsDir);
  fs.writeFileSync(path.join(reportsDir, 'helpdesk-report.html'), '<h1>Relatório secreto</h1>');
  store = createReportUserStore({ filePath: path.join(dir, 'users.json') });
  app = express();
  app.use('/reports', createReportsPanel({ userStore: store, reportsDir }));
});

async function login(username, password, agent = request.agent(app)) {
  const res = await agent.post('/reports/login').type('form').send({ username, password });
  return { agent, res };
}

describe('reports panel', () => {
  it('redirects anonymous visitors to the login page, keeping where they wanted to go', async () => {
    const res = await request(app).get('/reports/ver/helpdesk-report.html?empresa=Acme');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/reports/login?next=' + encodeURIComponent('/reports/ver/helpdesk-report.html?empresa=Acme'));
  });

  it('rejects wrong credentials', async () => {
    const { res } = await login('admin', 'errada');
    expect(res.status).toBe(401);
    expect(res.text).toContain('Usuário ou senha incorretos');
  });

  it('forces admin/admin to change the password before seeing any report', async () => {
    const { agent, res } = await login('admin', 'admin');
    expect(res.headers.location).toBe('/reports/senha');
    expect(res.headers['set-cookie'][0]).toMatch(/HttpOnly; SameSite=Strict/);

    expect((await agent.get('/reports/ver/helpdesk-report.html')).headers.location).toBe('/reports/senha');

    const changed = await agent.post('/reports/senha').type('form').send({ current: 'admin', password: 'senha-nova-1', confirm: 'senha-nova-1' });
    expect(changed.headers.location).toBe('/reports/?msg=senha-alterada');

    const report = await agent.get('/reports/ver/helpdesk-report.html');
    expect(report.status).toBe(200);
    expect(report.text).toContain('Relatório secreto');
    expect(report.headers['cache-control']).toBe('no-store');
  });

  it('sends the user back to the requested report after logging in', async () => {
    store.create({ username: 'ana', password: 'inicial-123' });
    store.changePassword('ana', 'inicial-123', 'senha-da-ana');
    const { res } = await (async () => {
      const agent = request.agent(app);
      return { res: await agent.post('/reports/login').type('form').send({ username: 'ana', password: 'senha-da-ana', next: '/reports/ver/helpdesk-report.html?empresa=Acme' }) };
    })();
    expect(res.headers.location).toBe('/reports/ver/helpdesk-report.html?empresa=Acme');

    const evil = await request(app).post('/reports/login').type('form').send({ username: 'ana', password: 'senha-da-ana', next: '//evil.example/' });
    expect(evil.headers.location).toBe('/reports/');
  });

  async function adminAgent() {
    store.changePassword('admin', 'admin', 'senha-admin-1');
    return (await login('admin', 'senha-admin-1')).agent;
  }

  it('lets an admin create, reset and remove users', async () => {
    const agent = await adminAgent();
    const created = await agent.post('/reports/usuarios').type('form').send({ username: 'joao', password: 'inicial-123', role: 'viewer' });
    expect(created.headers.location).toBe('/reports/usuarios?msg=usuario-criado');
    expect(store.get('joao')).toMatchObject({ role: 'viewer', mustChangePassword: true });

    await agent.post('/reports/usuarios/joao/redefinir').type('form').send({ password: 'temporaria-9' });
    expect(store.authenticate('joao', 'temporaria-9')).not.toBeNull();

    await agent.post('/reports/usuarios/joao/remover');
    expect(store.get('joao')).toBeNull();

    const self = await agent.post('/reports/usuarios/admin/remover');
    expect(self.status).toBe(400);
  });

  it('shows validation errors when creating a user', async () => {
    const agent = await adminAgent();
    const res = await agent.post('/reports/usuarios').type('form').send({ username: 'x', password: 'curta' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('Usuário inválido');
  });

  it('keeps viewers out of user management', async () => {
    store.create({ username: 'ana', password: 'inicial-123' });
    store.changePassword('ana', 'inicial-123', 'senha-da-ana');
    const { agent } = await login('ana', 'senha-da-ana');
    expect((await agent.get('/reports/usuarios')).status).toBe(403);
    expect((await agent.post('/reports/usuarios').type('form').send({ username: 'novo', password: 'inicial-123' })).status).toBe(403);
    expect(store.get('novo')).toBeNull();
  });

  it('ends the sessions of a removed user immediately', async () => {
    store.create({ username: 'ana', password: 'inicial-123' });
    store.changePassword('ana', 'inicial-123', 'senha-da-ana');
    const { agent: ana } = await login('ana', 'senha-da-ana');
    expect((await ana.get('/reports/')).status).toBe(200);
    store.remove('ana');
    expect((await ana.get('/reports/')).status).toBe(302);
  });

  it('blocks cross-origin POSTs and path traversal', async () => {
    const res = await request(app).post('/reports/login').set('Origin', 'https://evil.example').type('form').send({ username: 'admin', password: 'admin' });
    expect(res.status).toBe(403);

    const agent = await adminAgent();
    expect((await agent.get('/reports/ver/..%2Fusers.json')).status).toBe(404);
  });

  it('throttles repeated failed logins for the same user', async () => {
    for (let i = 0; i < 10; i++) await login('admin', 'errada-' + i);
    const { res } = await login('admin', 'admin');
    expect(res.status).toBe(429);
  });
});
