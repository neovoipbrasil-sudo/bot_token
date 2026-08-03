import axios from 'axios';
import { RateLimiter } from '../utils/rate-limiter.js';

const MAX_RETRIES = 3;

export class Bitrix24Client {
  constructor(webhookUrl) {
    this.webhookUrl = webhookUrl.endsWith('/') ? webhookUrl : webhookUrl + '/';
    this.limiter = new RateLimiter(500);
    this.portal = this._extractPortal(webhookUrl);
  }

  _extractPortal(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return 'unknown';
    }
  }

  async call(method, params = {}) {
    // Todas as tentativas (incluindo retries) rodam dentro de uma única tarefa
    // agendada no RateLimiter. Chamar this.limiter.schedule() de novo aqui
    // dentro travaria a fila para sempre: _process() ficaria esperando esta
    // mesma promise resolver antes de processar o novo item que ela mesma
    // acabou de enfileirar (deadlock observado em produção após um 429).
    return this.limiter.schedule(async () => {
      let retries = 0;
      for (;;) {
        try {
          const url = `${this.webhookUrl}${method}.json`;
          const response = await axios.post(url, params, { timeout: 30000 });
          if (response.data.error) {
            throw new Error(`Bitrix24 error [${response.data.error}]: ${response.data.error_description}`);
          }
          return response.data;
        } catch (err) {
          if (err.response?.status === 429 && retries < MAX_RETRIES) {
            const retryAfter = parseInt(err.response.headers['retry-after'] || '2', 10);
            await new Promise(r => setTimeout(r, retryAfter * 1000));
            retries += 1;
            continue;
          }
          if (err.code === 'ECONNABORTED' && retries < MAX_RETRIES) {
            const backoff = Math.pow(2, retries) * 1000;
            await new Promise(r => setTimeout(r, backoff));
            retries += 1;
            continue;
          }
          throw err;
        }
      }
    });
  }
}
