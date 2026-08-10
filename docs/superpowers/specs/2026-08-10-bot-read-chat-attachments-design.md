# Assistente lê anexos enviados no chat do Bitrix24

## Contexto

O bot do Bitrix24 (imbot.v2, botId 1052) hoje só processa `data.message.text` do
evento `ONIMBOTV2MESSAGEADD`. Quando o usuário anexa um arquivo na mensagem, o
texto (se houver) chega, mas o anexo em si é ignorado — o assistente não tem
como "ver" ou ler o conteúdo do arquivo.

O objetivo desta mudança é permitir que o usuário anexe um arquivo direto numa
mensagem do chat (PDF, Word/Excel, texto simples ou imagem) e o assistente leia
o conteúdo e responda com base nele, incluindo perguntas de acompanhamento em
mensagens seguintes sobre o mesmo arquivo.

## Escopo

- **Origem do arquivo**: anexo enviado diretamente na mensagem do chat
  (upload), não arquivos já armazenados no Disco referenciados por nome/ID.
- **Formatos suportados**: `pdf`, `docx`, `xlsx`, `txt`/`csv`/`md`, `png`/`jpg`.
- Outros formatos (ex: `.zip`, `.mp4`) não são lidos — o bot responde
  informando que aquele tipo de arquivo ainda não é suportado.

## Fluxo

1. O servidor (`src/bot/server.js`) detecta anexo(s) no evento
   `ONIMBOTV2MESSAGEADD` (além do texto que já lê hoje).
2. Para cada anexo, baixa o conteúdo do Bitrix24 (autenticado via webhook) e
   extrai um texto representativo do arquivo:
   - `txt`/`csv`/`md`: lido como texto puro.
   - `pdf`: extração de texto via `pdf-parse` (nova dependência).
   - `docx`: extração de texto via `mammoth` (nova dependência).
   - `xlsx`: lido via `exceljs` (já usada no projeto) e serializado como texto
     tabular.
   - `png`/`jpg`: chamada separada ao `claude` CLI, rodando com `cwd` num
     diretório temporário isolado contendo só aquele arquivo, com a ferramenta
     `Read` liberada apenas para esse diretório (usa a capacidade nativa do
     Claude Code de interpretar imagens via `Read`), pedindo uma
     descrição/transcrição do conteúdo visual.
3. O texto extraído (ou a descrição, no caso de imagem) é injetado como parte
   da mensagem do usuário — ex.: `[Anexo: nome.pdf]\n<texto extraído>` — antes
   de chamar `agentLoop.handleMessage`.
4. Como esse texto passa a fazer parte do histórico de conversa por diálogo
   (`conversation-history.js`, já existente), perguntas de acompanhamento em
   mensagens seguintes sobre o mesmo arquivo funcionam sem precisar reanexar.
5. `notifyAction` (indicador de "digitando/pensando") deve continuar ativo
   durante o download/extração do anexo, não só durante o raciocínio do
   modelo — a extração roda de forma síncrona antes de chamar o agent loop.

## Limites

- Texto extraído é truncado em ~20.000 caracteres; se passar disso, o bot
  avisa na resposta que o documento foi truncado.
- Download de anexos acima de ~15MB é recusado, com mensagem pedindo um
  arquivo menor.

## Módulo novo

`src/bot/attachment-reader.js`: exporta `readAttachment({url, filename})` →
baixa o arquivo e retorna `{text, truncated}` conforme a extensão, roteando
para o extrator certo (ou mensagem de "formato não suportado").

## Ponto em aberto para a implementação

O formato exato do payload que o Bitrix24 manda no evento
`ONIMBOTV2MESSAGEADD` quando a mensagem tem anexo não está confirmado. Antes
de codificar o parsing do payload, o primeiro passo prático da implementação é
logar (temporariamente) um evento real com anexo, enviado pelo usuário em
produção, para descobrir a forma certa dos campos (nome do arquivo, URL de
download, tipo).

## Fora de escopo

- Ler arquivos já armazenados no Disco por referência (nome/pasta/ID) sem
  anexo direto no chat — pode ser um tool separado no futuro, não faz parte
  desta mudança.
- Formatos além de pdf/docx/xlsx/txt/csv/md/png/jpg.
