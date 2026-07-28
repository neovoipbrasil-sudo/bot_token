import { describe, it, expect, vi, beforeEach } from 'vitest';

const callMock = vi.fn();

vi.mock('../bitrix24/client.js', () => ({
  Bitrix24Client: vi.fn().mockImplementation(function () {
    this.portal = 'test.bitrix24.com.br';
    this.call = callMock;
  }),
}));

const { generateDocument } = await import('./generate-document.js');

const WEBHOOK = 'https://test.bitrix24.com.br/rest/1/abc/';

describe('generateDocument', () => {
  beforeEach(() => {
    callMock.mockReset();
  });

  it('uploads the generated file to the given folder and returns its disk metadata', async () => {
    callMock.mockResolvedValueOnce({
      result: { ID: 42, NAME: 'relatorio.txt', SIZE: '11', DOWNLOAD_URL: 'https://test.bitrix24.com.br/disk/42/download' },
    });

    const result = await generateDocument({
      format: 'txt',
      filename: 'relatorio',
      content: 'Olá, mundo!',
      folder_id: 7,
      webhook_url: WEBHOOK,
    });

    expect(callMock).toHaveBeenCalledWith('disk.folder.uploadfile', {
      id: 7,
      data: { NAME: 'relatorio.txt' },
      fileContent: Buffer.from('Olá, mundo!', 'utf-8').toString('base64'),
    });
    expect(result.file).toEqual({ id: 42, name: 'relatorio.txt', size: 11, downloadUrl: 'https://test.bitrix24.com.br/disk/42/download' });
  });

  it('resolves the user root folder via disk.storage.getforapp when folder_id is omitted', async () => {
    callMock
      .mockResolvedValueOnce({ result: { ROOT_OBJECT: { ID: 99 } } })
      .mockResolvedValueOnce({ result: { ID: 1, NAME: 'a.txt', SIZE: '1', DOWNLOAD_URL: 'link' } });

    await generateDocument({ format: 'txt', filename: 'a', content: 'x', webhook_url: WEBHOOK });

    expect(callMock).toHaveBeenNthCalledWith(1, 'disk.storage.getforapp');
    expect(callMock).toHaveBeenNthCalledWith(2, 'disk.folder.uploadfile', expect.objectContaining({ id: 99 }));
  });

  it('propagates validation errors from buildDocument (e.g. missing content)', async () => {
    await expect(generateDocument({ format: 'txt', filename: 'a', webhook_url: WEBHOOK })).rejects.toThrow('content');
    expect(callMock).not.toHaveBeenCalled();
  });
});
