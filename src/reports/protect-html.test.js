import { describe, it, expect } from 'vitest';
import { parseCredentials, encryptHtml, unlockReport, openReport, protectHtml } from './protect-html.js';

// Poucas iterações só para os testes ficarem rápidos; o padrão de produção é PBKDF2_ITERATIONS.
const FAST = { iterations: 1000 };
const CREDS = [
  { user: 'Ana', password: 'segredo:1' },
  { user: 'joao', password: 'outra' },
];

describe('parseCredentials', () => {
  it('parses comma- and newline-separated user:password pairs, keeping ":" inside the password', () => {
    expect(parseCredentials('ana:a:b, joao:x\n# comentário\n\nmaria:y')).toEqual([
      { user: 'ana', password: 'a:b' },
      { user: 'joao', password: 'x' },
      { user: 'maria', password: 'y' },
    ]);
  });

  it('returns an empty list when nothing is configured', () => {
    expect(parseCredentials(undefined)).toEqual([]);
  });

  it('rejects entries without a password and duplicated users (case-insensitive)', () => {
    expect(() => parseCredentials('ana')).toThrow(/usuario:senha/);
    expect(() => parseCredentials('ana:1,ANA:2')).toThrow(/duplicado/);
  });
});

describe('encrypted report', () => {
  const html = '<h1>Relatório — Ação</h1>'.repeat(50);

  it('opens for every configured user, ignoring username case and surrounding spaces', async () => {
    const payload = encryptHtml(html, CREDS, FAST);
    for (const [user, password] of [[' ana ', 'segredo:1'], ['JOAO', 'outra']]) {
      const key = await unlockReport(payload, user, password);
      expect(key).not.toBeNull();
      expect(await openReport(payload, key)).toBe(html);
    }
  });

  it('refuses a wrong password, an unknown user, and another user\'s password', async () => {
    const payload = encryptHtml(html, CREDS, FAST);
    expect(await unlockReport(payload, 'ana', 'errada')).toBeNull();
    expect(await unlockReport(payload, 'pedro', 'segredo:1')).toBeNull();
    expect(await unlockReport(payload, 'ana', 'outra')).toBeNull();
  });

  it('does not leak the report content, usernames or passwords into the protected page', () => {
    const page = protectHtml('<p>Cliente Secreto LTDA</p>', CREDS, { ...FAST, title: 'Relatório Help Desk' });
    expect(page).toContain('Relatório Help Desk');
    for (const leak of ['Cliente Secreto', 'Ana', 'joao', 'segredo:1', 'outra']) expect(page).not.toContain(leak);
  });

  it('requires at least one credential', () => {
    expect(() => encryptHtml(html, [])).toThrow(/credencial/);
  });
});
