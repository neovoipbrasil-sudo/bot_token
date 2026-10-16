import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

// Guarda, por telefone, as linhas de mensagens que chegaram enquanto
// findCrmEntity não encontrava nenhum lead/negócio aberto para elas
// ("no-match"), junto com o ticketId mais recente em que isso aconteceu.
// Quando o telefone finalmente casar com um lead/negócio — seja porque
// chegou uma mensagem nova (syncTimeline) ou porque reconcile-pending.js
// encontrou o match num ciclo periódico, sem esperar mensagem nova — essas
// linhas são recuperadas e inseridas na timeline, em vez de perdidas.
export function createPendingStore({ filePath }) {
  function ensureDir() {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  function load() {
    if (!existsSync(filePath)) return {};
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  }

  function persist(data) {
    ensureDir();
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  // Registros antigos guardavam um array de linhas direto (sem ticketId).
  // Normaliza pra sempre trabalhar com { ticketId, lines }.
  function normalize(entry) {
    if (!entry) return { ticketId: null, lines: [] };
    if (Array.isArray(entry)) return { ticketId: null, lines: entry };
    return { ticketId: entry.ticketId ?? null, lines: entry.lines ?? [] };
  }

  return {
    appendPending(phone, line, ticketId) {
      const data = load();
      const { lines } = normalize(data[phone]);
      lines.push(line);
      data[phone] = { ticketId: ticketId ?? null, lines };
      persist(data);
    },

    // Retorna { ticketId, lines } com o que está pendente do telefone e
    // remove do armazenamento — cada lote de mensagens perdidas só deve ser
    // recuperado uma única vez.
    takePending(phone) {
      const data = load();
      const pending = normalize(data[phone]);
      if (pending.lines.length > 0) {
        delete data[phone];
        persist(data);
      }
      return pending;
    },

    // Todos os telefones com algo pendente agora — usado por
    // reconcile-pending.js para saber quais telefones reconsultar.
    listPhones() {
      return Object.keys(load());
    },
  };
}
