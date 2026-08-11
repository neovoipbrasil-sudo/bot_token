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
   `ONIMBOTV2MESSAGEADD` (além do texto que já lê hoje). O guard atual em
   `server.js:38` (`if (!dialogId || !userId || !text) return;`) descarta
   qualquer evento sem `text` — isso precisa mudar para
   `if (!dialogId || !userId || (!text && !hasAttachment)) return;`, senão o
   caso mais comum (usuário manda só o arquivo, sem legenda) é silenciosamente
   ignorado e a feature nunca dispara.
2. Para cada anexo, baixa o conteúdo do Bitrix24 e extrai um texto
   representativo do arquivo:
   - **Autenticação do download**: `readAttachment` precisa receber a mesma
     credencial usada pelos outros módulos que falam com o Bitrix24
     (`botConfig.botToken`, como em `reply.js`, ou o webhook resolvido via
     `resolveWebhook()`, como em `generate-document.js`) — não dá para supor
     que a URL do anexo já vem pré-assinada/pública.
   - **Validação da URL antes do download**: a URL recebida no payload deve
     ser validada contra o domínio esperado do Bitrix24 (ex.: mesmo host do
     webhook configurado) antes de disparar o GET, para não abrir um vetor de
     SSRF caso o payload seja manipulado ou mal-parseado.
   - **Checagem de tamanho antes de baixar**: o limite de ~15MB (ver
     "Limites") deve ser checado via header `Content-Length` da resposta
     antes de ler o corpo, e abortado em streaming se o corpo ultrapassar o
     limite mesmo sem `Content-Length` confiável — nunca baixar o arquivo
     inteiro para só então rejeitar por tamanho.
   - `txt`/`csv`/`md`: lido como texto puro.
   - `pdf`: extração de texto via `pdf-parse` (nova dependência).
   - `docx`: extração de texto via `mammoth` (nova dependência).
   - `xlsx`: lido via `exceljs` (já usada no projeto) e serializado como texto
     tabular.
   - `png`/`jpg`: chamada separada ao `claude` CLI, rodando com `cwd` num
     diretório temporário isolado contendo só aquele arquivo, com a ferramenta
     `Read` liberada apenas para esse diretório (usa a capacidade nativa do
     Claude Code de interpretar imagens via `Read`), pedindo uma
     descrição/transcrição do conteúdo visual. O diretório temporário deve
     ser removido (`fs.rm(..., {recursive: true})`) num `finally`, garantindo
     limpeza mesmo se a chamada ao CLI falhar.
   - **Erros de download/extração**: se o download falhar (rede, 404, link
     expirado) ou a extração falhar (arquivo corrompido/inválido), o bot
     responde ao usuário informando que não conseguiu ler aquele anexo
     específico, mas segue processando o texto da mensagem (se houver) e
     os demais anexos normalmente — nunca deixa a mensagem sem resposta.
3. O texto extraído (ou a descrição, no caso de imagem) é injetado como parte
   da mensagem do usuário — ex.: `[Anexo: nome.pdf]\n<texto extraído>` — antes
   de chamar `agentLoop.handleMessage`.
4. Como esse texto passa a fazer parte do histórico de conversa por diálogo
   (`conversation-history.js`, já existente), perguntas de acompanhamento em
   mensagens seguintes sobre o mesmo arquivo funcionam sem precisar reanexar.
   Ciente do custo: como `claude-code-adapter.js` roda cada chamada sem
   persistência de sessão, cada pergunta de acompanhamento reenvia o texto
   extraído inteiro (até ~20.000 caracteres) como parte do histórico — é um
   trade-off aceito nesta primeira versão em troca de simplicidade
   (sem cache/resumo de anexos entre turnos); não é um objetivo desta mudança
   otimizar esse custo.
5. `notifyAction` (indicador de "digitando/pensando") deve continuar ativo
   durante o download/extração do anexo, não só durante o raciocínio do
   modelo. Hoje `server.js:52` dispara uma única chamada de 60s sem renovação;
   como download + extração (principalmente a chamada extra ao `claude` CLI
   para imagens) pode se somar ao tempo do agent loop e ultrapassar 60s, o
   `notifyAction` precisa ser re-disparado (ex.: a cada ~40s) enquanto o
   processamento do anexo estiver em andamento, não só uma vez no início.

## Limites

- Texto extraído é truncado em ~20.000 caracteres; se passar disso, o bot
  avisa na resposta que o documento foi truncado.
- Download de anexos acima de ~15MB é recusado, com mensagem pedindo um
  arquivo menor — checado antes de baixar o corpo inteiro (ver Fluxo, item 2).

## Módulo novo

`src/bot/attachment-reader.js`: exporta `readAttachment({url, filename, auth})`
→ baixa o arquivo (autenticado, com validação de host e checagem de tamanho
por streaming) e retorna `{text, truncated}` conforme a extensão, roteando
para o extrator certo (ou mensagem de "formato não suportado"), ou lança um
erro específico que o chamador converte na mensagem de "não consegui ler esse
anexo" (ver item 2 do Fluxo).

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
