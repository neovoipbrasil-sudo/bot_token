import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

// Cache local de "contato → leads/negócios em que ele aparece como contato
// adicional (não principal)". crm.lead.list / crm.deal.list só filtram pelo
// contato PRINCIPAL de cada registro (campo CONTACT_ID); o campo nativo que
// deveria cobrir todos os contatos vinculados (CONTACT_IDS) está quebrado
// nesse portal — qualquer filtro nele é ignorado e a API devolve todos os
// registros. Como a API do Bitrix não tem nenhuma busca reversa ("em quais
// leads esse contato aparece?"), esse índice é reconstruído periodicamente
// em segundo plano (ver refresh-additional-contacts.js) varrendo todos os
// leads/negócios abertos, e consultado como último recurso pelo
// findCrmEntity.
export function createAdditionalContactsIndex({ filePath }) {
  function ensureDir() {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  function load() {
    if (!existsSync(filePath)) return {};
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  }

  return {
    getEntities(contactId) {
      const data = load();
      return data[contactId] ?? [];
    },

    // Substitui o índice inteiro de uma vez — o refresh recompõe o mapa
    // completo do zero a cada ciclo, então não faz sentido mesclar com o
    // conteúdo anterior (leads/negócios fechados nesse meio-tempo devem
    // sair do índice, não continuar acumulando).
    replaceAll(map) {
      ensureDir();
      writeFileSync(filePath, JSON.stringify(map, null, 2), 'utf-8');
    },
  };
}
