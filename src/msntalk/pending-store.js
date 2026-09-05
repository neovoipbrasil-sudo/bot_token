import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

// Guarda, por telefone, as linhas de mensagens que chegaram enquanto
// findCrmEntity não encontrava nenhum lead/negócio aberto para elas
// ("no-match"). Quando o telefone finalmente casar com um lead/negócio,
// syncTimeline usa takePending para recuperar essas linhas e inseri-las
// no início da timeline, em vez de perdê-las para sempre.
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

  return {
    appendPending(phone, line) {
      const data = load();
      const lines = data[phone] ?? [];
      lines.push(line);
      data[phone] = lines;
      persist(data);
    },

    // Retorna as linhas pendentes do telefone e as remove do armazenamento —
    // cada lote de mensagens perdidas só deve ser recuperado uma única vez.
    takePending(phone) {
      const data = load();
      const lines = data[phone] ?? [];
      if (lines.length > 0) {
        delete data[phone];
        persist(data);
      }
      return lines;
    },
  };
}
