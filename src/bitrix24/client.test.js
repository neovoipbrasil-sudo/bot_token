import { describe, it, expect, vi, beforeEach } from 'vitest';

const postMock = vi.fn();
vi.mock('axios', () => ({ default: { post: (...args) => postMock(...args) } }));

const { Bitrix24Client } = await import('./client.js');

describe('Bitrix24Client', () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it('does not deadlock the request queue after a 429 retry', async () => {
    const client = new Bitrix24Client('https://portal.bitrix24.com.br/rest/1/abc/');

    postMock
      .mockRejectedValueOnce({
        response: { status: 429, headers: { 'retry-after': '0' } },
      })
      .mockResolvedValueOnce({ data: { result: 'first-ok' } })
      .mockResolvedValueOnce({ data: { result: 'second-ok' } });

    const firstCall = client.call('crm.deal.list');
    const secondCall = client.call('crm.lead.list');

    const results = await Promise.race([
      Promise.all([firstCall, secondCall]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out — queue deadlocked')), 2000)),
    ]);

    expect(results[0].result).toBe('first-ok');
    expect(results[1].result).toBe('second-ok');
    expect(postMock).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting retries on repeated 429s without hanging', async () => {
    const client = new Bitrix24Client('https://portal.bitrix24.com.br/rest/1/abc/');

    postMock.mockRejectedValue({
      response: { status: 429, headers: { 'retry-after': '0' } },
    });

    await expect(
      Promise.race([
        client.call('crm.deal.list'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out — queue deadlocked')), 2000)),
      ])
    ).rejects.toMatchObject({ response: { status: 429 } });
  });

  it('surfaces a Bitrix24 API error without hanging the queue', async () => {
    const client = new Bitrix24Client('https://portal.bitrix24.com.br/rest/1/abc/');

    postMock
      .mockResolvedValueOnce({ data: { error: 'INVALID_REQUEST', error_description: 'bad field' } })
      .mockResolvedValueOnce({ data: { result: 'ok-after' } });

    await expect(client.call('crm.deal.update')).rejects.toThrow('INVALID_REQUEST');
    await expect(client.call('crm.deal.list')).resolves.toEqual({ result: 'ok-after' });
  });
});
