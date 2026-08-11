# Assistente lê anexos enviados no chat do Bitrix24 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o bot do Bitrix24 baixar, extrair texto e responder com base em anexos (PDF, DOCX, XLSX, TXT/CSV/MD, PNG/JPG) enviados diretamente numa mensagem do chat.

**Architecture:** Um novo módulo `src/bot/attachment-reader.js` baixa o anexo (com validação de host e limite de tamanho por streaming) e extrai texto por formato. `src/bot/server.js` passa a resolver anexos do evento `ONIMBOTV2MESSAGEADD`, chama `readAttachment` para cada um, injeta o texto extraído na mensagem do usuário antes de chamar `agentLoop.handleMessage`, e mantém o indicador de "digitando" ativo durante todo o processamento.

**Tech Stack:** Node.js (ESM), Express, axios, `pdf-parse` (novo), `mammoth` (novo), `exceljs` (já usado), Vitest + Supertest para testes.

## Global Constraints

- Formatos suportados: `pdf`, `docx`, `xlsx`, `txt`/`csv`/`md`, `png`/`jpg`/`jpeg`. Qualquer outro formato retorna mensagem de "não suportado", nunca lança exceção não tratada.
- Texto extraído é truncado em 20.000 caracteres (`MAX_TEXT_CHARS`); se truncado, o texto retornado inclui aviso de truncamento.
- Download de anexo é recusado acima de 15MB (`MAX_DOWNLOAD_BYTES`), checado via `Content-Length` antes do corpo e abortado em streaming se o corpo ultrapassar o limite mesmo sem header confiável.
- A URL de download deve estar no mesmo domínio-base `bitrix24.<tld>` do portal (derivado de `bitrixClient.portal`, não da URL de entrada do bot) antes de qualquer requisição HTTP ser feita — nunca baixar de um host arbitrário.
- Falha em baixar/extrair um anexo específico nunca deve deixar a mensagem do usuário sem resposta — vira um aviso point-a-ponto ("não consegui ler o anexo X") e o processamento segue com o texto e os demais anexos.
- Diretórios temporários criados para análise de imagem são sempre removidos num `finally`.
- Todo texto de usuário/erro voltado ao chat é em português do Brasil.

---

## Contexto para quem for implementar

O bot já tem um pipeline funcionando: `src/bot/server.js` recebe o evento `ONIMBOTV2MESSAGEADD` do Bitrix24, hoje só lê `data.chat.dialogId`, `data.user.id` e `data.message.text`, e chama `agentLoop.handleMessage({userId, dialogId, text})`. O `agentLoop` (`src/bot/agent-loop.js`) roda um loop de chamadas ao modelo (via `claude-code-adapter.js`, que invoca o `claude` CLI) com um histórico de conversa persistido em `src/bot/conversation-history.js`.

**O formato exato do payload que o Bitrix24 manda quando a mensagem tem um anexo já foi descoberto** (Task 1, executada em produção antes deste plano começar a rodar) — ver detalhes na Task 1 abaixo.

`createApp()` em `server.js` já recebe `bitrixClient` (instância de `Bitrix24Client`, ver `src/bitrix24/client.js`) e `botConfig` (`{botId, botToken, webhookUrl}`, ver `src/bot/bot-config.json`) como parâmetros — então não é preciso mexer em `src/bot/bootstrap.js` para plumbing de autenticação; tudo que o novo código precisa já está disponível dentro de `createApp`.

---

### Task 1: Descobrir o formato real do payload de anexo — CONCLUÍDA

Esta task já foi executada manualmente em produção (log temporário + dois envios reais do usuário no chat do bot em 2026-08-11) antes do início da execução deste plano. O log temporário já foi revertido (`src/bot/server.js` está limpo). **Resultado real capturado**, usado como base de verdade pelas Tasks 2 e 8:

```json
{
  "data": {
    "message": {
      "text": "Preciso que você leia o documento e verifique as informações que são editáveis para virar um modelo",
      "params": { "FILE_ID": ["184226"] }
    },
    "chat": { "dialogId": "6", "diskFolderId": "183928" },
    "user": { "id": "6" }
  }
}
```

E, para o envio sem legenda (só anexo):

```json
{
  "data": {
    "message": {
      "text": "",
      "params": { "FILE_ID": ["184236"] }
    }
  }
}
```

**Achados confirmados:**
- O anexo **não** vem como um array `files` com nome/URL/tamanho prontos (a suposição original do spec estava errada). Vem em `data.message.params.FILE_ID`, um **array de strings com IDs de arquivo do Disco do Bitrix24** (ex.: `["184226"]`) — sem nome, sem URL de download, sem tamanho.
- Para obter nome/URL/tamanho de cada anexo é necessário chamar `disk.file.get` (já existe como tool interno, ver `src/tools/disk.js:diskFileGet`) com `{ id: fileId }`. A resposta (`res.result`) traz `NAME`, `SIZE`, `DOWNLOAD_URL` em maiúsculas — mesmo padrão já usado em `disk.folder.getchildren`/`generate-document.js`.
- `data.message.text` chega como `""` (string vazia), não `undefined`, quando não há legenda — o guard atual (`!text` → `return`) realmente descarta esse caso.
- `data.chat.dialogId` e `data.user.id` continuam exatamente como o código já lê hoje.
- O `DOWNLOAD_URL` retornado por `disk.file.get` está em domínio do Bitrix24 (`*.bitrix24.com.br`, possivelmente num subdomínio de CDN como `cdn.bitrix24.com.br`, não necessariamente o mesmo host exato do webhook REST) — **não** é o mesmo host do `botConfig.webhookUrl` do bot (que é a URL do nosso túnel/endpoint de entrada de eventos, não tem relação com o domínio do portal). Isso corrige um erro do desenho original da Task 2 (ver nota lá).

Esta task não precisa ser reexecutada — os campos abaixo (Tasks 2 e 8) já refletem esse achado real.

---

### Task 2: `attachment-reader.js` — download com validação de host e limite de tamanho

**Files:**
- Create: `src/bot/attachment-reader.js`
- Test: `src/bot/attachment-reader.test.js`

**Interfaces:**
- Produces:
  - `export async function readAttachment({ url, filename, size, portalHost })` → `Promise<{ text: string, truncated: boolean }>` — usado pela Task 7 (via `server.js`). `portalHost` é o hostname do portal Bitrix24 (ex.: `bitrixClient.portal`, já exposto por `Bitrix24Client` em `src/bitrix24/client.js:9`), **não** a URL do webhook de entrada do bot — o Bitrix24 pode servir o download num subdomínio de CDN diferente do host do REST (ex.: `cdn.bitrix24.com.br` vs `neo-voip.bitrix24.com.br`), então a validação abaixo compara pelo domínio-base `bitrix24.<tld>`, não pelo hostname exato.
  - `export const MAX_DOWNLOAD_BYTES` (15 * 1024 * 1024) e `export const MAX_TEXT_CHARS` (20000) — constantes reaproveitadas pelas próximas tasks.
  - Internamente (não exportado ainda nesta task, mas usado pelas próximas): `downloadAttachment(url, portalHost)` → `Promise<Buffer>`, que valida host e limite de tamanho.
- Consumes: nada de tasks anteriores (é o módulo raiz da feature).

- [ ] **Step 1: Escrever o teste de validação de host**

```js
import { describe, it, expect, vi } from 'vitest';
import axios from 'axios';
import { readAttachment } from './attachment-reader.js';

vi.mock('axios');

describe('readAttachment', () => {
  it('rejects a download URL whose domain is not the portal\'s bitrix24 domain', async () => {
    const result = await readAttachment({
      url: 'https://evil.example.com/file.txt',
      filename: 'file.txt',
      portalHost: 'neo-voip.bitrix24.com.br',
    });
    expect(result.text).toMatch(/não consegui/i);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('accepts a download URL on a different bitrix24 subdomain than the portal (e.g. CDN)', async () => {
    axios.get.mockResolvedValue({ data: Buffer.from('ok', 'utf-8') });
    const result = await readAttachment({
      url: 'https://cdn.bitrix24.com.br/b24060375/file.txt',
      filename: 'file.txt',
      portalHost: 'neo-voip.bitrix24.com.br',
    });
    expect(axios.get).toHaveBeenCalled();
    expect(result.text).toContain('ok');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/bot/attachment-reader.test.js`
Expected: FAIL — `attachment-reader.js` não existe.

- [ ] **Step 3: Implementar o módulo (download + validação de host + limite de tamanho + roteamento por extensão, ainda sem extratores específicos)**

```js
import axios from 'axios';

export const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
export const MAX_TEXT_CHARS = 20_000;

const EXTRACTORS = {};

export function registerExtractor(extensions, fn) {
  for (const ext of extensions) EXTRACTORS[ext] = fn;
}

function extensionOf(filename) {
  const match = /\.([a-zA-Z0-9]+)$/.exec(filename || '');
  return match ? match[1].toLowerCase() : '';
}

// Bitrix24 can serve file downloads from a different subdomain than the
// portal's own REST host (e.g. a CDN subdomain) — compare against the
// shared "bitrix24.<tld>" base domain derived from the portal's own
// hostname, not an exact hostname match.
function sameBitrixDomain(url, portalHost) {
  try {
    const downloadHost = new URL(url).hostname;
    const match = /(bitrix24\.[a-z.]+)$/i.exec(portalHost || '');
    if (!match) return downloadHost === portalHost;
    const baseDomain = match[1].toLowerCase();
    const lowerDownloadHost = downloadHost.toLowerCase();
    return lowerDownloadHost === baseDomain || lowerDownloadHost.endsWith(`.${baseDomain}`);
  } catch {
    return false;
  }
}

export function truncateText(text) {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true };
}

async function downloadAttachment(url, portalHost) {
  if (!sameBitrixDomain(url, portalHost)) {
    throw new Error('URL de anexo fora do domínio esperado do Bitrix24.');
  }

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30_000,
    maxContentLength: MAX_DOWNLOAD_BYTES,
    maxBodyLength: MAX_DOWNLOAD_BYTES,
  });

  return Buffer.from(response.data);
}

export async function readAttachment({ url, filename, size, portalHost }) {
  try {
    if (size && size > MAX_DOWNLOAD_BYTES) {
      return { text: `[Anexo: ${filename}]\nNão consegui ler: arquivo maior que 15MB, manda uma versão menor.`, truncated: false };
    }

    const ext = extensionOf(filename);
    const extract = EXTRACTORS[ext];
    if (!extract) {
      return { text: `[Anexo: ${filename}]\nNão consegui ler: formato ".${ext}" ainda não é suportado.`, truncated: false };
    }

    const buffer = await downloadAttachment(url, portalHost);
    const rawText = await extract(buffer);
    const { text, truncated } = truncateText(rawText);
    const suffix = truncated ? '\n[...documento truncado, era maior que o limite de leitura]' : '';
    return { text: `[Anexo: ${filename}]\n${text}${suffix}`, truncated };
  } catch (err) {
    return { text: `[Anexo: ${filename}]\nNão consegui ler esse anexo: ${err.message}`, truncated: false };
  }
}
```

`axios.maxContentLength`/`maxBodyLength` cobrem o caso de streaming sem `Content-Length` confiável — o axios aborta a request assim que o corpo lido ultrapassa o limite, sem esperar o download inteiro terminar.

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/bot/attachment-reader.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/bot/attachment-reader.js src/bot/attachment-reader.test.js package.json package-lock.json
git commit -m "feat(bot): add attachment-reader with host-validated, size-capped download"
```

---

### Task 3: Extrator de texto puro (`txt`/`csv`/`md`)

**Files:**
- Modify: `src/bot/attachment-reader.js`
- Test: `src/bot/attachment-reader.test.js`

**Interfaces:**
- Consumes: `registerExtractor(extensions, fn)` da Task 2.
- Produces: nada novo exportado — registra o formato `txt`/`csv`/`md` na tabela interna de extratores usada por `readAttachment`.

- [ ] **Step 1: Escrever o teste**

```js
it('extracts plain text for txt/csv/md attachments', async () => {
  axios.get.mockResolvedValue({ data: Buffer.from('nome,status\nMaria,Novo', 'utf-8') });
  const result = await readAttachment({
    url: 'https://minhaempresa.bitrix24.com.br/file.csv',
    filename: 'clientes.csv',
    portalHost: 'minhaempresa.bitrix24.com.br',
  });
  expect(result.text).toContain('nome,status\nMaria,Novo');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/bot/attachment-reader.test.js`
Expected: FAIL — `.csv` não tem extrator registrado, cai no branch de "formato não suportado".

- [ ] **Step 3: Implementar e registrar**

No fim de `src/bot/attachment-reader.js`:

```js
registerExtractor(['txt', 'csv', 'md'], async buffer => buffer.toString('utf-8'));
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/bot/attachment-reader.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/bot/attachment-reader.js src/bot/attachment-reader.test.js
git commit -m "feat(bot): read plain-text attachments (txt/csv/md)"
```

---

### Task 4: Extrator de PDF (`pdf-parse`)

**Files:**
- Modify: `src/bot/attachment-reader.js`, `package.json`
- Test: `src/bot/attachment-reader.test.js`

**Interfaces:**
- Consumes: `registerExtractor` da Task 2.
- Produces: nada novo exportado — registra `pdf`.

- [ ] **Step 1: Instalar a dependência**

```bash
npm install pdf-parse
```

- [ ] **Step 2: Escrever o teste**

```js
import pdfParse from 'pdf-parse';
vi.mock('pdf-parse');

it('extracts text from pdf attachments via pdf-parse', async () => {
  axios.get.mockResolvedValue({ data: Buffer.from('fake-pdf-bytes') });
  pdfParse.mockResolvedValue({ text: 'Contrato de prestação de serviços...' });

  const result = await readAttachment({
    url: 'https://minhaempresa.bitrix24.com.br/file.pdf',
    filename: 'contrato.pdf',
    portalHost: 'minhaempresa.bitrix24.com.br',
  });

  expect(result.text).toContain('Contrato de prestação de serviços');
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run src/bot/attachment-reader.test.js`
Expected: FAIL — `.pdf` sem extrator.

- [ ] **Step 4: Implementar e registrar**

No topo do arquivo, adicionar `import pdfParse from 'pdf-parse';`. No fim:

```js
registerExtractor(['pdf'], async buffer => {
  const data = await pdfParse(buffer);
  return data.text;
});
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run src/bot/attachment-reader.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/bot/attachment-reader.js src/bot/attachment-reader.test.js package.json package-lock.json
git commit -m "feat(bot): read pdf attachments via pdf-parse"
```

---

### Task 5: Extrator de DOCX (`mammoth`)

**Files:**
- Modify: `src/bot/attachment-reader.js`, `package.json`
- Test: `src/bot/attachment-reader.test.js`

**Interfaces:**
- Consumes: `registerExtractor` da Task 2.
- Produces: nada novo exportado — registra `docx`.

- [ ] **Step 1: Instalar a dependência**

```bash
npm install mammoth
```

- [ ] **Step 2: Escrever o teste**

```js
import mammoth from 'mammoth';
vi.mock('mammoth');

it('extracts text from docx attachments via mammoth', async () => {
  axios.get.mockResolvedValue({ data: Buffer.from('fake-docx-bytes') });
  mammoth.extractRawText.mockResolvedValue({ value: 'Termos e condições do contrato...' });

  const result = await readAttachment({
    url: 'https://minhaempresa.bitrix24.com.br/file.docx',
    filename: 'termos.docx',
    portalHost: 'minhaempresa.bitrix24.com.br',
  });

  expect(result.text).toContain('Termos e condições do contrato');
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run src/bot/attachment-reader.test.js`
Expected: FAIL — `.docx` sem extrator.

- [ ] **Step 4: Implementar e registrar**

Topo do arquivo: `import mammoth from 'mammoth';`. Fim do arquivo:

```js
registerExtractor(['docx'], async buffer => {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
});
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run src/bot/attachment-reader.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/bot/attachment-reader.js src/bot/attachment-reader.test.js package.json package-lock.json
git commit -m "feat(bot): read docx attachments via mammoth"
```

---

### Task 6: Extrator de XLSX (`exceljs`, já é dependência do projeto)

**Files:**
- Modify: `src/bot/attachment-reader.js`
- Test: `src/bot/attachment-reader.test.js`

**Interfaces:**
- Consumes: `registerExtractor` da Task 2.
- Produces: nada novo exportado — registra `xlsx`.

- [ ] **Step 1: Escrever o teste**

```js
it('extracts tabular text from xlsx attachments via exceljs', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Vendas');
  sheet.addRow(['Nome', 'Status']);
  sheet.addRow(['Maria', 'Novo']);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  axios.get.mockResolvedValue({ data: buffer });

  const result = await readAttachment({
    url: 'https://minhaempresa.bitrix24.com.br/file.xlsx',
    filename: 'vendas.xlsx',
    portalHost: 'minhaempresa.bitrix24.com.br',
  });

  expect(result.text).toContain('Nome\tStatus');
  expect(result.text).toContain('Maria\tNovo');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/bot/attachment-reader.test.js`
Expected: FAIL — `.xlsx` sem extrator.

- [ ] **Step 3: Implementar e registrar**

Topo do arquivo: `import ExcelJS from 'exceljs';`. Fim do arquivo:

```js
registerExtractor(['xlsx'], async buffer => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const lines = [];
  workbook.eachSheet(sheet => {
    lines.push(`# ${sheet.name}`);
    sheet.eachRow(row => {
      lines.push(row.values.slice(1).map(v => (v ?? '').toString()).join('\t'));
    });
  });
  return lines.join('\n');
});
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/bot/attachment-reader.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/bot/attachment-reader.js src/bot/attachment-reader.test.js
git commit -m "feat(bot): read xlsx attachments via exceljs"
```

---

### Task 7: Extrator de imagem (`png`/`jpg`/`jpeg`) via `claude` CLI com diretório temporário isolado

**Files:**
- Modify: `src/bot/attachment-reader.js`
- Test: `src/bot/attachment-reader.test.js`

**Interfaces:**
- Consumes: `registerExtractor` da Task 2; `spawn` de `node:child_process`; `mkdtemp`/`writeFile`/`rm` de `node:fs/promises`.
- Produces: nada novo exportado — registra `png`/`jpg`/`jpeg`. Introduz `describeImage(buffer, extension)` (não exportado) usado só internamente.

- [ ] **Step 1: Escrever o teste**

```js
import { spawn } from 'node:child_process';
vi.mock('node:child_process');

function fakeChildProcess(stdout) {
  const listeners = {};
  return {
    stdout: { on: (event, cb) => { if (event === 'data') cb(Buffer.from(stdout)); } },
    stderr: { on: () => {} },
    stdin: { write: () => {}, end: () => {} },
    on: (event, cb) => {
      listeners[event] = cb;
      if (event === 'close') cb(0);
    },
  };
}

it('describes image attachments via a scoped claude CLI subprocess and cleans up the temp dir', async () => {
  axios.get.mockResolvedValue({ data: Buffer.from('fake-png-bytes') });
  spawn.mockReturnValue(fakeChildProcess(JSON.stringify({ result: 'Print de tela mostrando um erro 500 no formulário de checkout.' })));

  const result = await readAttachment({
    url: 'https://minhaempresa.bitrix24.com.br/file.png',
    filename: 'erro.png',
    portalHost: 'minhaempresa.bitrix24.com.br',
  });

  expect(result.text).toContain('Print de tela mostrando um erro 500');
  expect(spawn).toHaveBeenCalledWith('claude', expect.arrayContaining(['-p', '--output-format', 'json']), expect.objectContaining({ cwd: expect.any(String) }));
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/bot/attachment-reader.test.js`
Expected: FAIL — `.png` sem extrator.

- [ ] **Step 3: Implementar e registrar**

Topo do arquivo:

```js
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
```

Fim do arquivo:

```js
function runClaudeOnImage(imagePath) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '-p',
      '--output-format', 'json',
      '--no-session-persistence',
      '--safe-mode',
      '--allowedTools', 'Read',
      '--add-dir', path.dirname(imagePath),
    ], { cwd: path.dirname(imagePath), stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`claude exited with code ${code} ao descrever imagem`));
      resolve(stdout);
    });
    child.stdin.write(`Leia o arquivo de imagem "${path.basename(imagePath)}" com a ferramenta Read e descreva objetivamente o que está escrito e visível nele, em português do Brasil.`);
    child.stdin.end();
  });
}

async function describeImage(buffer, extension) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bot-attachment-'));
  try {
    const imagePath = path.join(dir, `imagem.${extension}`);
    await writeFile(imagePath, buffer);
    const stdout = await runClaudeOnImage(imagePath);
    const envelope = JSON.parse(stdout);
    return envelope.result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

registerExtractor(['png', 'jpg', 'jpeg'], async (buffer, ext) => describeImage(buffer, ext));
```

Isso exige que `EXTRACTORS[ext]` receba `(buffer, ext)` — ajustar a chamada em `readAttachment` (Task 2) de `extract(buffer)` para `extract(buffer, ext)`, e os extratores anteriores (Tasks 3-6) continuam válidos porque JS ignora argumentos extras não usados.

- [ ] **Step 4: Ajustar a chamada em `readAttachment`**

Em `readAttachment`, trocar:

```js
    const rawText = await extract(buffer);
```

por:

```js
    const rawText = await extract(buffer, ext);
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run src/bot/attachment-reader.test.js`
Expected: PASS — incluindo os testes das Tasks 3-6, que não devem quebrar.

- [ ] **Step 6: Commit**

```bash
git add src/bot/attachment-reader.js src/bot/attachment-reader.test.js
git commit -m "feat(bot): describe image attachments via a scoped claude CLI subprocess"
```

---

### Task 8: Wiring em `server.js` — detectar anexos, resolver via Task 1, chamar `readAttachment`, manter o indicador de "digitando" vivo

**Files:**
- Modify: `src/bot/server.js`
- Test: `src/bot/server.test.js`

**Interfaces:**
- Consumes: `readAttachment({url, filename, size, portalHost})` da Task 2 (`{text, truncated}`); `bitrixClient.call(method, params)` (já injetado em `createApp`, usado aqui para `disk.file.get`); `bitrixClient.portal` (hostname do portal, já exposto por `Bitrix24Client`, ver `src/bitrix24/client.js:9`).
- Produces: `handleEvent` passa a montar o `text` enviado ao `agentLoop.handleMessage` incluindo o texto de qualquer anexo, e nunca early-return quando só há anexo sem texto.

**Formato real do payload (confirmado na Task 1):** o anexo chega em `data.message.params.FILE_ID`, um array de strings com IDs de arquivo do Disco (ex.: `["184226"]`) — sem nome/URL/tamanho prontos. Para cada ID é preciso chamar `bitrixClient.call('disk.file.get', { id })`, cujo `res.result` traz `NAME`, `SIZE`, `DOWNLOAD_URL` (maiúsculas, mesmo padrão de `src/tools/disk.js:diskFileGet`).

- [ ] **Step 1: Escrever o teste do guard corrigido (mensagem só com anexo, sem texto)**

Em `src/bot/server.test.js`, adicionar (a função `setup()` já existente no arquivo precisa passar a aceitar `bitrixClient` como override — ver ajuste no Step 1b):

```js
it('processes an attachment-only message (no text) instead of silently dropping it', async () => {
  const bitrixClient = { call: vi.fn().mockResolvedValue({ result: { NAME: 'nota.txt', SIZE: 10, DOWNLOAD_URL: 'https://neo-voip.bitrix24.com.br/download/nota.txt' } }) };
  const { app, agentLoop } = setup({ handleMessageImpl: async () => ({ replies: ['Recebi o arquivo!'] }), bitrixClient });
  const res = await request(app).post('/bitrix-events').send(eventBody({
    data: {
      chat: { id: 5, dialogId: 'dialog-1' },
      user: { id: 'user-1' },
      message: { id: 1, text: '', params: { FILE_ID: ['184226'] } },
    },
  }));

  expect(res.status).toBe(200);
  await vi.waitFor(() => expect(agentLoop.handleMessage).toHaveBeenCalled());
  expect(bitrixClient.call).toHaveBeenCalledWith('disk.file.get', { id: '184226' });
  const call = agentLoop.handleMessage.mock.calls[0][0];
  expect(call.text).toContain('[Anexo: nota.txt]');
});
```

- [ ] **Step 1b: Permitir override de `bitrixClient` no helper `setup()` existente**

`src/bot/server.test.js` já define `setup({ handleMessageImpl, allowed } = {})` (topo do arquivo) que monta `createApp({...})` sem passar `bitrixClient`. Ajuste a assinatura para aceitar um `bitrixClient` opcional e repassá-lo:

```js
function setup({ handleMessageImpl, allowed = true, bitrixClient = { call: vi.fn().mockResolvedValue({ result: {} }) } } = {}) {
  const agentLoop = { handleMessage: vi.fn(handleMessageImpl ?? (async () => ({ replies: ['ok'] }))) };
  const reply = vi.fn().mockResolvedValue();
  const replyWithFile = vi.fn().mockResolvedValue();
  const rateLimiter = { checkAndConsume: vi.fn(() => (allowed ? { allowed: true } : { allowed: false, scope: 'user' })) };
  const app = createApp({ botConfig: { botId: 456, botToken: 'secret-token' }, agentLoop, reply, replyWithFile, rateLimiter, bitrixClient });
  return { app, agentLoop, reply, replyWithFile, rateLimiter, bitrixClient };
}
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/bot/server.test.js`
Expected: FAIL — o guard atual (`!text` → `return`) descarta o evento antes de chamar `agentLoop.handleMessage`, e `disk.file.get` nunca é chamado.

- [ ] **Step 3: Implementar**

Em `src/bot/server.js`, importar no topo:

```js
import { readAttachment } from './attachment-reader.js';
```

Substituir o trecho de `server.js:24-64` (handler completo de `/bitrix-events`) por:

```js
  app.post('/bitrix-events', (req, res) => {
    const token = req.body?.auth?.application_token;
    if (token !== expectedToken) {
      return res.status(403).send('forbidden');
    }

    res.status(200).send('ok');

    if (req.body.event !== 'ONIMBOTV2MESSAGEADD') return;

    const dialogId = req.body.data?.chat?.dialogId;
    const userId = req.body.data?.user?.id;
    const text = req.body.data?.message?.text || '';
    const fileIds = req.body.data?.message?.params?.FILE_ID || [];
    if (!dialogId || !userId || (!text && fileIds.length === 0)) return;

    handleEvent({ dialogId, userId, text, fileIds }).catch(() => {
      // handleEvent already replies to the user on every error path; this catch
      // only guards against reply() itself throwing, which we can't recover from.
    });

    async function handleEvent({ dialogId, userId, text, fileIds }) {
      const rl = rateLimiter.checkAndConsume(userId);
      if (!rl.allowed) {
        await reply(dialogId, 'Você está enviando mensagens rápido demais, aguarde um instante e tente de novo.');
        return;
      }

      let keepThinkingAlive = true;
      notifyAction(dialogId, 'IMBOT_AGENT_ACTION_THINKING', 60).catch(() => {});
      const thinkingInterval = setInterval(() => {
        if (keepThinkingAlive) notifyAction(dialogId, 'IMBOT_AGENT_ACTION_THINKING', 60).catch(() => {});
      }, 40_000);

      try {
        let fullText = text;
        for (const fileId of fileIds) {
          let attachmentText;
          try {
            const fileRes = await bitrixClient.call('disk.file.get', { id: fileId });
            const file = fileRes.result;
            ({ text: attachmentText } = await readAttachment({
              url: file.DOWNLOAD_URL,
              filename: file.NAME,
              size: Number(file.SIZE),
              portalHost: bitrixClient.portal,
            }));
          } catch (err) {
            attachmentText = `[Anexo ${fileId}]\nNão consegui ler esse anexo: ${err.message}`;
          }
          fullText = fullText ? `${fullText}\n\n${attachmentText}` : attachmentText;
        }

        const { replies } = await agentLoop.handleMessage({ userId, dialogId, text: fullText });
        for (const msg of replies) {
          if (typeof msg === 'string') await reply(dialogId, msg);
          else await replyWithFile(dialogId, msg.message, msg.file);
        }
      } catch (err) {
        console.error('bitrix-events: handleMessage failed:', err.message);
        await reply(dialogId, 'Não consegui processar sua mensagem agora, tenta de novo em instantes.');
      } finally {
        keepThinkingAlive = false;
        clearInterval(thinkingInterval);
      }
    }
  });
```

Note duas camadas de tratamento de erro por anexo: o `try/catch` em volta de `disk.file.get` + `readAttachment` cobre falha ao resolver o arquivo no Disco (ID inválido, sem permissão etc.), e `readAttachment` (Task 2) já cobre internamente falha de download/extração depois de resolvido — nenhuma delas interrompe o loop dos demais anexos nem impede a resposta final.

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/bot/server.test.js`
Expected: PASS — incluindo os testes já existentes (guard de token, rate limit, erro do agent loop, etc.), que não devem quebrar.

- [ ] **Step 5: Rodar a suíte inteira**

Run: `npm test`
Expected: PASS em todos os arquivos.

- [ ] **Step 6: Commit**

```bash
git add src/bot/server.js src/bot/server.test.js
git commit -m "feat(bot): read chat attachments (pdf/docx/xlsx/txt/image) before replying"
```

---

## Self-Review

**Cobertura do spec:**
- Escopo (formatos suportados/não suportados) → Tasks 2-7 (roteamento por extensão + mensagem de "não suportado" no branch `else` de `readAttachment`).
- Fluxo item 1 (detectar anexo no evento, sem descartar mensagens sem texto) → Task 8, Step 3 (guard corrigido, lendo `data.message.params.FILE_ID` conforme payload real da Task 1).
- Fluxo item 2, autenticação/validação de host/checagem de tamanho → Task 2 (`sameBitrixDomain`, `maxContentLength`/`maxBodyLength`, checagem de `size` antes do download) + Task 8 (resolução de nome/URL/tamanho via `disk.file.get`, autenticado pelo próprio `bitrixClient` do webhook REST — nunca pela URL do túnel de entrada do bot).
- Fluxo item 2, extratores por formato → Tasks 3 (texto), 4 (pdf), 5 (docx), 6 (xlsx).
- Fluxo item 2, imagem via `claude` CLI em diretório isolado + limpeza → Task 7.
- Fluxo item 2, erro de download/extração não trava a mensagem → Task 2 (`try/catch` em `readAttachment` devolve texto de aviso).
- Fluxo item 3 (texto injetado como `[Anexo: nome]\n<texto>`) → Task 2, `readAttachment`.
- Fluxo item 4 (histórico de conversa cobre follow-up) → nenhuma mudança necessária: `agentLoop`/`conversation-history.js` já persistem `text`, e o texto do anexo agora faz parte desse `text`.
- Fluxo item 5 (`notifyAction` ativo durante todo o processamento) → Task 8, `setInterval` de 40s coberto por `try/finally`.
- Limites (truncamento em ~20k chars, recusa acima de 15MB) → Task 2 (`MAX_TEXT_CHARS`, `MAX_DOWNLOAD_BYTES`).
- "Ponto em aberto" do spec (formato real do payload) → Task 1, já executada antes da implementação (log real capturado em produção); Task 8 usa o formato confirmado (`data.message.params.FILE_ID` + `disk.file.get`), não mais uma suposição.
- Fora de escopo (Disco por referência, outros formatos) → nenhuma task implementa isso, consistente com o spec.

**Placeholder scan:** nenhum "TBD"/"implementar depois" nas tasks de código (2-8). A Task 1 já foi executada (não é mais uma etapa pendente) e seu resultado real está documentado inline nela mesma.

**Consistência de tipos:** `readAttachment({url, filename, size, portalHost})` → `{text, truncated}` é o único formato usado em Tasks 2 a 8, sem divergência de nome de campo (corrigido de `webhookUrl` para `portalHost` em todas as tasks após a descoberta da Task 1, já que a validação de host precisa comparar com o domínio do portal Bitrix24, não com a URL de entrada do bot). `registerExtractor(extensions, fn)` e a assinatura `fn(buffer, ext)` (ajustada na Task 7 e válida retroativamente para Tasks 3-6, que ignoram o segundo argumento) são consistentes em todas as tasks que a usam.
