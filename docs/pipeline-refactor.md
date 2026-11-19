# Refatoração do pipeline: desenho para revisão

Estado: **rascunho para discussão** (2026-11-18). Nenhum código foi alterado por este documento.

## 1. Por que mudar

O pipeline cresceu por acréscimos. O mesmo tipo de item recebe tratamento diferente conforme **onde** está, e a mesma lógica existe mais de uma vez:

- O anexo de email é renderizado dentro de `converter.ts` com cópias próprias de `processDocxToPdf`, `processExcelToPdf` e `processPdfAttachment`, separadas do `standalone-processor.ts` da pasta Files. Só passam `.pdf`, `.docx`, `.doc`, `.xlsx`, `.xls`, `.csv` e `.zip`; `.pptx`, `.txt` e imagens somem em silêncio.
- O email do PST e o `.eml`/`.msg` da pasta Files seguem regras diferentes (palavra-chave, filtro de nome, "escrito pelo titular").
- Há duas pilhas de IA: `ai_batch_runs` + `ai.ts` + `email-rereview.ts` (emails) e `files_ai_*` + `files-ai.ts` + `files-ai-rereview.ts` (arquivos e anexos).
- O filtro "titular ausente" roda depois da extração, na fase de IA.
- Uma conversa de Teams (um HTML com dezenas de mensagens) é mantida ou descartada inteira.

Exemplo real (caso em andamento): 44.692 arquivos na pasta Files, dos quais 12.810 HTML (conversas), 6.467 imagens, 16.372 `.docx`, 258 `.mp4`, 364 `.loop`, 2.015 `.json`.

## 2. Princípios

1. **Uma regra por tipo de item, válida onde quer que o item esteja.** Todo email recebe as regras de email; todo arquivo, as de arquivo; toda mensagem de chat, as de mensagem.
2. **Os itens formam uma árvore**: email → anexos → email aninhado → anexos… Cada anexo guarda a referência do email de origem.
3. **Do mais barato ao mais caro**: nome, palavra-chave, hash duplicado, titular citado e só então IA.
4. **Todo descarte deixa motivo e regra** (trilha de auditoria).
5. **Errar por manter, não por descartar** (há revisão humana depois).
6. Nada é filtrado "em silêncio": tipo não suportado também é descartado com registro.

## 3. Modelo de item

Uma tabela `items` (nova, ao lado das atuais no início):

| Campo | Significado |
|---|---|
| `id` | hash estável do item |
| `case_request_id` | pedido |
| `parent_id` | item de origem (email do anexo, email que contém o email aninhado) ou `null` |
| `kind` | `email`, `file`, `image`, `sheet`, `chat_message` |
| `origin` | `pst`, `files_folder`, `attachment` |
| `state` | `pending`, `kept`, `discarded`, `review` |
| `decision_rule` | regra que decidiu (`dup`, `draft`, `keyword`, `subject_absent`, `ai_email`, `signature_image`, `unsupported_type`, …) |
| `reason` | texto curto |
| `cascade` | se o descarte leva os filhos junto |

`item_events` (histórico): cada mudança de estado, com regra, motivo e data. É a trilha de auditoria.

Regra de cascata: descarte por **confidencial** (palavra-chave ou triagem) tem `cascade = true`, e os anexos nem são extraídos. Descarte por **não citar o titular** tem `cascade = false`, e os anexos seguem sozinhos.

## 4. Fluxo alvo

```
PST --readpst--> emails
  filtro 1 (barato, antes de extrair o conteúdo):
     duplicata -> rascunho -> palavra-chave (assunto+corpo, sem assinatura)
     -> titular citado? (nome, alias, endereço, parte local)
     -> autoencaminhamento? (separa para Emails/Warning)
  sobrou -> extrai payload -> IA de email (regras do 1º e 2º email)
  para cada anexo do email (mesmo se o email foi descartado só por "não citar"):
     email aninhado -> volta ao filtro 1
     arquivo        -> pipeline de arquivos (origem = o email)
     imagem         -> regras de imagem

Pasta Files --> arquivos / mensagens de chat / imagens / planilhas
     tipo não suportado (mp4, loop, json, bin, ...) -> descartado + auditoria
     senha? -> descartado
     arquivo: palavra-chave no nome -> hash duplicado -> citado? -> IA
     planilha: manter só as linhas com o titular; sem o titular, descartar
     chat: por mensagem
```

### 4.1 Regras de email (módulo único)

Valem para email do PST, `.eml`/`.msg` da pasta Files e email aninhado:

- Palavra-chave no assunto **e** no corpo, ignorando a assinatura e o aviso de confidencialidade (`hasPrivilegedKeyword`, já implementado).
- Exceção: enviado direto ao email pessoal do titular (uma implementação só).
- Titular citado em qualquer lugar do payload; senão, descarte sem cascata.
- IA: primeiro email do PDF é o mais recente; o titular no corpo só conta se o email for sobre o titular como pessoa; segundo email só em encaminhamento ou resposta com 2 participantes; menção no fundo da cadeia não conta; titular enviou ou recebeu = mantém.

### 4.2 Regras de arquivo

Palavra-chave no nome; hash duplicado; protegido por senha descartado; arquivo grande por amostra; titular citado; IA para confidencialidade e relevância. Planilha por linha. O filtro "titular citado" usa o **mesmo conjunto de tokens** do email.

### 4.3 Mensagens de Teams

Cada conversa (HTML) é dividida nas mensagens (`message__author`, `message__recepient`, `message__time`, `message__content`).

- Mantém a mensagem em que o titular é autor, destinatário ou é mencionado e que seja sobre o titular como pessoa; tarefa ou "fale com a Maria" descarta.
- Mantém 2 mensagens de contexto de cada lado (configurável).
- Palavra-chave por trecho, não pelo arquivo inteiro.
- Renderiza só os trechos mantidos, com a referência da conversa.
- Deduplica por mensagem (autor + hora + texto), não por hash de arquivo.

### 4.4 Imagens: assinatura x conteúdo

Camadas, do barato ao caro, a primeira que decidir encerra:

1. **Posição**: imagem depois do início da assinatura (mesmos marcadores do `stripEmailSignature`) é assinatura.
2. **Forma**: 1×1 (pixel de rastreio), ícone pequeno, banner largo e baixo, poucos KB.
3. **Nome e origem**: `image001.png`, `Outlook-*.png`, `logo`, `linkedin`; imagem anexada (não inline) com tamanho de documento tende a ser conteúdo.
4. **Recorrência** (reforço, não requisito): mesmo hash em muitos emails do mesmo remetente ou domínio.
5. **IA com visão (Haiku)** só para os ambíguos: assinatura, logo ou decoração x foto de documento ou dado pessoal.

Vale para uma ou 200 ocorrências. A resposta de outra empresa tem o logo dela uma vez só e cai nas camadas 1 a 3. Cada imagem descartada registra o sinal usado.

Imagens coladas em chat (`0-brs-d4-<hash>.png`) seguem a mesma regra: emoji, avatar e reação são ignorados; captura de tela de documento vai para a IA.

### 4.5 Trilha de auditoria

Cada item descartado ou enviado a revisão grava em `item_events`: regra, motivo, quem decidiu (regra determinística, Haiku 4.5, Haiku 5.5). Exportada junto com `Discarded/verdicts.csv` (que já existe para arquivos), agora para todos os tipos.

## 5. Camada de IA única

Uma tabela de itens para julgar e um poller, com `kind` escolhendo o prompt: email, arquivo, mensagem, imagem. Uma única segunda revisão (Haiku 5.5 sobre descartes do 4.5 com dúvida). O cliente Bedrock, o roteamento por registros (Batch acima de 100) e o limite de jobs já são compartilhados e continuam.

## 6. Comparação com hoje

| Tema | Hoje | Alvo |
|---|---|---|
| Palavra-chave de email | PST: só assunto; pasta Files: assunto e corpo | assunto e corpo sem assinatura, um módulo (feito para email) |
| "Titular ausente" | depois da extração, na IA | antes de extrair |
| Anexos | `converter.ts`, só alguns tipos | pipeline de arquivos, todos os tipos, com origem |
| Imagens | descartadas ou encolhidas | regras de assinatura + IA nos ambíguos |
| Email na pasta Files | descartado se "escrito pelo titular"; prompt de documento | regras de email |
| Teams | conversa inteira | por mensagem (feito) |
| IA | duas pilhas | uma |
| Auditoria | parcial (`ai_reason`, `verdicts.csv`) | `item_events` para tudo |
| Autoencaminhamento | pasta `Warning` | continua separado (alerta ao RH), com a regra e o motivo na trilha |

## 7. Ordem de migração

Cada passo entrega valor sozinho e tem rollback simples. Antes de começar: um conjunto de referência (casos sintéticos + um caso real pequeno) e um **diff do que é entregue** entre a versão atual e a nova em cada passo.

0. **`items` + `item_events` em modo sombra (feito)**: gravar os mesmos descartes que existem hoje, sem mudar a decisão. Dá a trilha de auditoria e permite comparar os passos seguintes. **Emails feitos** (2026-11-19): tabelas `items`/`item_events` (migração `20261119100000_items_shadow`), `src/lib/items.ts` (`syncEmailItems`, só grava, nunca lança) chamado depois de cada decisão de email (palavra-chave, rascunho, titular ausente, caso de cliente, autoencaminhamento, IA 4.5/5.5, segunda revisão, triagem de anexos e corpo). Duplicatas não têm linha própria hoje e ainda não entram na trilha. **Arquivos de Files feitos**: cada descarte do motor (`recordDiscard` em `standalone-processor.ts`, com a regra: `dup`, `password`, `keyword`, `subject_absent`, `empty_output`, `chat_legacy`) chega por `onDecision` ao `phase-runner`, que grava com `recordFileItems`; os vereditos da IA de arquivos (`keep`/`discard`/`review`) são gravados em `applyFilesAiVerdicts`, indexados pelo caminho entregue (o caminho de entrada e o de saída ainda não se juntam). Falta: o worker legado `files-worker.ts`, os arquivos mantidos pelo motor, as duplicatas de email, anexos como itens próprios (passo 3) Trilha exportada (2026-11-19): `exportAuditTrail` grava `<request>/Discarded/audit-trail.csv` (item, tipo, origem, pai, estado, regra, motivo, quem decidiu, quando) ao fim do Render e ao aplicar os vereditos da IA de Files, só em pedido que descartou algo; a coluna `label` guarda o caminho do arquivo ou o nome do anexo, nunca o assunto do email (a trilha não cria dado pessoal novo; emails aparecem pelo prefixo do hash). **Passo 0 fechado** (2026-11-19): duplicatas de email entram como itens filhos do email que duplicam (`createDuplicateRecorder`, gravação em bloco, regra `dup`, idempotente no reprocessamento); o motor de Files também reporta o arquivo **mantido** com o caminho entregue (`Documents/<nome>`), que é a identidade do item, então o veredito de IA que vem depois cai no mesmo item (um item, vários eventos) e o rótulo continua sendo o caminho de origem; o `files-worker.ts` legado grava na trilha. O CSV lista só descartes e revisões (mantidos ficam no banco). Testes: `item-decision.test.ts`, `items-audit.test.ts`.
1. **Módulos de regras únicos** (email, arquivo, mensagem) e tokens de titular únicos, com teste de que o mesmo item dá o mesmo resultado em qualquer caminho. Fecha as diferenças de "onde o item está". **Feito para email e arquivo** (2026-11-18): `subject-rules.ts` (titular citado, exceção do e-mail pessoal), `email-rules.ts` (decisão de palavra-chave do email, chamada pelo analisador e pelo motor de Files), `hasPrivilegedKeywordInDocument` (arquivos e anexos), teste de equivalência em `standalone-mail-rules.test.ts`. A mensagem de Teams entrou no passo 5.
2. **"Titular citado" antes da extração**; sai o pré-filtro da IA. **Feito** (2026-11-19): `extractUniqueEmails` descarta o email que não cita o titular em nenhuma parte (cabeçalhos, assunto, corpo inteiro, nomes de anexos) antes de montar o payload, com a razão `Pre-filter: Data subject not mentioned`; o pré-filtro de `ai.ts` foi removido. O EML fica no lugar, para os anexos (passo 3). Teste: `extract-subject-filter.test.ts`. Ainda não é antes do `readpst`: o filtro roda no Extract, depois do Parse.
3. **Anexos no pipeline de arquivos**: abre `.txt`, zips (`.ppt`/`.pptx` são descartados); tipo não suportado descartado com auditoria; remove as cópias do `converter.ts`. **Parcialmente feito** (2026-11-19). Correção do desenho: não havia cópias dos conversores. `office-worker.ts` (usado pela pasta Files) já chama `processDocxToPdf`/`processExcelToPdf` de `converter.ts`, então `.docx`, `.xlsx` e PDF já são a mesma regra nos dois caminhos. Feito: `.txt` virou tipo suportado de anexo, com uma só função (`processTextToPdf` em `converter.ts`: palavra-chave do documento, exceção do e-mail pessoal, titular citado, dedup), usada também pela pasta Files — o `.txt` de Files **ganhou** a regra de palavra-chave que não tinha; todo anexo descartado (tipo não suportado, protegido por senha, zip ilegível, triagem de confidencialidade, palavra-chave e titular ausente do `.txt`) vira item filho do email na trilha (`recordAttachmentItems`); os conversores de docx, xlsx e PDF só dizem que não entregaram (`attachment_filter`), sem o motivo exato. Decisão (2026-11-19): `.ppt` e `.pptx` são descartados (não há conversor), com a regra `unsupported_type` na trilha. Falta: tipos de imagem (passo 4), motivo exato nos conversores de docx/xlsx/PDF e anexos mantidos na trilha.
4. **Imagens**: camadas 1 a 4 primeiro; IA de visão depois. **Parcialmente feito** (2026-11-19): `src/lib/image-rules.ts` (`readImageFacts` lê largura e altura do cabeçalho de PNG, GIF, JPEG e WebP; `classifyImage`). Camada 2 (forma: pixel de rastreio, ícone até 64 px, arquivo abaixo de 5 KB, banner largo e baixo) e camada 3 (nome tipo `image001`, `Outlook-*`, `logo`, redes sociais, só junto com imagem pequena, porque o Outlook também chama capturas coladas de `image001.png`). Mesmo classificador para anexo de email e para imagem da pasta Files. Assinatura: descartada com o sinal na trilha (`signature_image`). O resto: vira PDF e vai para revisão humana (anexo: `For Human Review/Emails/<Email> Image N.pdf`; Files: PDF sem texto, que o gate de IA já manda para revisão). Imagem embutida no corpo do email (`related`) continua só no PDF do email. Antes, anexos de imagem sumiam e as imagens de Files eram puladas só com um log. Falta: camada 1 (posição depois da assinatura, precisa do HTML), camada 4 (recorrência entre emails), IA com visão (Haiku) para os ambíguos e o motivo de cada imagem mantida na trilha; BMP, TIFF e HEIC seguem como tipo não suportado. Testes: `image-rules.test.ts`.
5. **Teams por mensagem**: segmentação, contexto, renderização de trechos, deduplicação por mensagem. **Feito** (2026-11-19): `src/lib/teams-chat.ts` divide o HTML em `div.message` (autor, data, hora, destinatário, conteúdo); conferido em 400 conversas reais, todas segmentaram. Candidata é a mensagem em que o titular é autor, destinatário ou é citado (mesmos tokens do passo 1); cada candidata fica com 2 mensagens de contexto de cada lado (`CHAT_CONTEXT_MESSAGES`), janelas vizinhas viram um trecho. Palavra-chave por trecho (um trecho com a palavra cai, os outros ficam), exceção do e-mail pessoal mantida. Só os trechos entram no PDF, com o nome da conversa e a marca das mensagens que citam o titular. Dedup por mensagem (autor, data, hora e texto), então a reexportação da mesma conversa não entrega duas vezes. Saíram as regras por local: cabeçalho "Nome <email> data", "mensagem do topo escrita pelo titular" e "resposta direta". HTML que não é chat (sem `div.message`) segue as regras de documento. Caso de cliente continua entregando a conversa inteira. "Sobre o titular como pessoa" (tarefa ou "fale com a Maria" descarta) não é regra fixa: quem julga é a triagem de IA do Files, que lê o trecho renderizado. Falta: gravar a mensagem mantida na trilha (hoje só o arquivo), tornar o contexto configurável, e imagens coladas em chat (`0-brs-d4-<hash>.png`) ligadas à mensagem de origem. Testes: `teams-chat.test.ts`.
6. **Unificar a IA** (uma tabela, um poller, uma segunda revisão). **Parcialmente feito** (2026-11-19): **uma segunda revisão.** `src/lib/second-review.ts` tem o único motor (recupera reivindicações de worker morto, resolve o cliente Converse, reivindica linhas em blocos com atualização atômica, liquida com concorrência limitada dentro de um orçamento de tempo, não deixa linha presa sem credencial AWS). `email-rereview.ts` e `files-ai-rereview.ts` viraram adaptadores finos do motor: só dizem o que é uma linha e o que uma falha significa (email: falha mantém; arquivo: falha vai para revisão humana), comportamento igual ao anterior (testes de banco dos dois passam sem mudança). O portão que decide quem é revisado já era um só (`bedrock/rereview-gate.ts`). Falta: **um poller** (`runBatchSweep` já varre os dois, mas cada pilha acompanha os jobs na sua tabela, `ai_batch_runs` e `files_ai_batch_runs`) e **uma tabela de itens para julgar** (`kind` escolhendo o prompt), o que só fecha de verdade junto com o passo 7 (`items` como fonte de verdade), porque exige migrar o estado de IA que hoje vive em `emails` e `files_ai_verdicts`. Teste: `second-review.test.ts`.
7. **Tornar `items` a fonte de verdade** e aposentar os campos antigos.

## 8. Decisões já tomadas

- Descarte por confidencial leva os anexos; descarte por "não citar" não leva.
- Mensagens e arquivos seguem as mesmas regras do email, por mensagem.
- Tipos que não dá para triar (`.mp4`, `.loop`, `.json`, `.bin`, `.ppt`, `.pptx`, outros) são descartados e listados na auditoria.
- O autoencaminhamento continua separado (alerta ao RH).
- "Titular ausente" roda antes da extração.
- Os PSTs continuam sendo apagados após o Render verificado (disco de 1 TB; já houve casos acima disso). Reprocessar um caso só acontece por erro do pipeline, e nesse caso o PST ainda existe, porque o apagamento vem depois de um Render verificado. Reauditar com outro titular não é um caso de uso.

## 9. Limites e pontos abertos

- O `readpst` escreve todos os emails em disco antes do filtro 1. O filtro economiza as fases seguintes (payload, IA, Render), não essa escrita. Reduzir isso exigiria processar o PST em fluxo, fora do escopo.
- **Casos de cliente** ficam para depois, junto com a unificação dos critérios: o processo de empregado entrega mais do que a SAR da ICO exige.
- O que fazer com anexos `.mp4` etc. que o RH queira ver: hoje, descartados e auditados.
- Tamanho do contexto do Teams (2 mensagens) e regras para conversas em grupo grandes.
- Custo: o filtro de "titular citado" não foi removido, só movido para o Extract (passo 2), então esse passo não muda o custo da IA. O que pode subir é o passo 1: o conjunto de tokens ficou mais amplo (primeiro e último nome sozinhos, parte local do email, os dois emails), e passa mais email para a IA. Medir no caso real antes de decidir se o critério precisa apertar.
