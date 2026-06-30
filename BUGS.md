# 🐛 Batalha Naval — Relatório de Bugs (teste em celulares)

> Gerado em 2026-06-28 a partir de uma leitura completa do código (cliente, servidor e
> da fonte do PixiJS 7.4.3 instalado). Os bugs de **toque/arraste** ainda precisam de
> confirmação rodando num aparelho real — veja a seção [Verificação pendente](#-verificação-pendente).

> ## ✅ STATUS: TODOS CORRIGIDOS (2026-06-29)
> Os 7 bugs abaixo foram corrigidos e **revalidados no navegador** em viewport mobile
> **390×844** com toque emulado (eventos de ponteiro sintéticos exercitando os handlers
> reais), além do **LOOP A** do motor (**356 / 22.715 / 37** asserções, **0 falhas**) e
> `assert-no-errors --strict` (zero erros de console/JS/WebSocket).
>
> Durante a revalidação foi descoberto e corrigido um **8º bug crítico**, que era a causa
> real de *"não consegui usar nenhum poder mesmo com energia"*: os sprites de navio e os
> marcadores de acerto **engoliam o toque nas células sob eles**, tornando o **Reparo
> impossível** (o alvo do Reparo é sempre uma célula danificada do seu **próprio** navio,
> portanto sempre sob um navio + marcador). Detalhes na [Resolução](#-resolução-2026-06-29).
>
> **Os 6 power-ups foram exercitados de ponta a ponta no navegador** (Tiro, Sonar, Salva
> Tripla, Torpedo, Bombardeio, Reparo) — selecionar → mirar no tabuleiro → FOGO → ação
> aplicada. **Nenhuma regra/lógica/economia do motor foi alterada** (a economia de energia
> ficou intacta a pedido do usuário; o problema dos power-ups não era de energia).

## Contexto do teste relatado
- **Jogador 1 — Android:** quase não conseguia clicar para atirar. Só depois de ~2 min "clicando feito louco" conseguia selecionar a célula-alvo.
- **Jogador 2 — iPhone:** não conseguia posicionar os barcos; eles **voltavam para a posição inicial**. A partida começou com a frota no layout padrão.
- **Ambos:** não conseguiram usar **nenhum** power-up.

## Legendas
- **Severidade:** 🔴 crítico · 🟠 alto · 🟡 médio · ⚪ baixo
- **Confiança na causa-raiz:** ✅ alta · 🟦 média · ❓ a confirmar no aparelho

## O que **não** é a causa (já descartado)
Para não perder tempo: investiguei e **descartei** estas hipóteses comuns:
- ❌ *"O overlay de HUD bloqueia o toque":* `#ui` é `pointer-events:none` (`css/style.css:38`). OK.
- ❌ *"Falta `touch-action:none` no canvas":* o PixiJS define isso sozinho no `<canvas>` (`@pixi/events/.../EventSystem.js:172`). OK.
- ❌ *"O tabuleiro não recebe o clique (sem `hitArea`)":* confirmei na fonte do Pixi que o `fillLayer` preenchido torna o container clicável via `containsPoint`. O hit-test **funciona**. O problema é a *fragilidade* do gesto, não o acerto.

---

## Tabela de prioridade

| # | Bug | Sev. | Conf. | Sintoma do usuário |
|---|-----|------|-------|--------------------|
| 1 | Performance pesada trava o input no celular | 🔴 | 🟦❓ | "2 min clicando feito louco" |
| 2 | Arraste só confirma se o `pointermove` disparou → barco volta ao início | 🔴 | ✅ | "barcos voltam pra posição inicial" |
| 3 | Power-ups travados por energia + sem feedback quando indisponível | 🟠 | ✅ | "não usei nenhum poder" |
| 4 | `pointertap` para atirar é frágil (sem `pointercancel`, sem tolerância) | 🟠 | 🟦 | "não consigo clicar pra atirar" |
| 5 | Painéis de DOM cobrem o topo do tabuleiro e roubam o toque | 🟡 | ✅ | barcos das linhas de cima não pegam |
| 6 | Deadlock de animação pode congelar o tabuleiro | 🟡 | 🟦 | tabuleiro "morre" depois de um tiro |
| 7 | `clientId` é compartilhado entre abas do mesmo aparelho | ⚪ | ✅ | não dá pra testar 2 jogadores numa máquina |

---

## 1. 🔴 Performance pesada trava o input no celular
**Sintoma:** toques demoram muito a registrar; arraste no iPhone praticamente não funciona.

**Causa provável (🟦, confirmar no aparelho):** a cena WebGL é muito pesada para celulares
intermediários, saturando CPU/GPU e atrasando o processamento dos eventos de ponteiro. Camadas caras empilhadas:
- Oceano animado por shader (`public/js/gfx/water.js`).
- `BlurFilter` no brilho da grade, **todo frame** (`public/js/gfx/board.js:49-51`).
- Sprite de radar girando com máscara + `BLEND_MODES.ADD` (`board.js:39-47`).
- `DisplacementFilter` de "calor" sobre a camada de FX (`public/js/scene.js:29-49`).
- Emissão contínua de partículas: brasa, fumaça, heat-haze e espuma (`board.js:437-468`).
- `resolution: min(devicePixelRatio, 2)` (`public/js/gfx/app.js:13`) → em telas com DPR 3 isso renderiza em 2x.

O degradador automático de qualidade só age **uma vez**, e só depois de 4 s com FPS < 45
(`app.js:80-92`). Num aparelho que já começa travado, o input continua engasgado.

**Correção sugerida:**
- Detectar mobile (UA / `matchMedia('(pointer: coarse)')` / tela pequena) e **já iniciar em qualidade reduzida**.
- No modo reduzido: remover `BlurFilter` e `DisplacementFilter`, pausar o radar, cortar o orçamento de partículas pela metade.
- Limitar `resolution` a ~1.5 no celular (`app.js:13`).
- Considerar baixar o limite do degradador (FPS < 50) e permitir degradar em mais de um nível.

---

## 2. 🔴 Arraste só confirma se o `pointermove` disparou (barco volta ao início)
**Sintoma:** no iPhone os barcos não saíam do lugar — voltavam para a posição inicial.

**Causa (✅):** o commit do arraste depende de `this.drag.candidate`, que **só é preenchido dentro do `_onMove`** (`public/js/placement.js:143`). No `_onUp`:

```js
// public/js/placement.js:157-169
_onUp() {
  if (!this.drag) return;
  const cand = this.drag.candidate;          // undefined se nenhum pointermove chegou
  ...
  if (cand && cand.valid) { p.r = cand.r0; p.c = cand.c0; }  // só comita aqui
  this.drag = null;
  this._refreshAll();                          // senão, devolve o sprite pra p.r,p.c (posição antiga)
}
```

Se os eventos de `pointermove` forem **engasgados/descartados** (jank do item #1) ou o gesto for
**cancelado** pelo iOS, `candidate` fica `undefined` e o `_onUp` **devolve o barco para onde estava** —
exatamente o "volta pra posição inicial". Como o drag falha, o Jogador 2 acabou confirmando a frota no
**layout padrão** (`_defaultLayout`, cada navio numa linha par na coluna 0 — `placement.js:29-32`).

**Agrava:** o PixiJS **não escuta `pointercancel`** (`EventSystem.js:172` registra só down/move/up/leave/over).
No iOS, um `pointercancel` no meio do gesto faz o `_onUp` (ligado a `pointerup`/`pointerupoutside`) **nunca rodar** → o drag fica pendurado.

**Correção sugerida:**
- No `_onUp`, se não houver `candidate`, calcular a célula final pela **última posição do ponteiro** (ou pela posição atual do sprite) e comitar mesmo assim.
- Usar **pointer capture** (`setPointerCapture`) no `pointerdown` do barco.
- Tratar `pointercancel`/`pointerout` como um `_onUp` (commit best-effort ou cancelamento limpo).

---

## 3. 🟠 Power-ups: travados por energia + sem feedback quando indisponíveis
**Sintoma:** "não consegui usar nenhum poder".

**Causa (✅) — três fatores combinados:**

1. **Economia de energia** (`server/constants.js`): começa em **0**, ganha **+1 por turno**
   (`ENERGY` em `constants.js:30-35`). Custos: sonar **2**, salva tripla **3**, torpedo/bombardeio/reparo **4**
   (`constants.js:21-28`). Ou seja, **nos primeiros turnos você não tem energia para nada** além do tiro normal (custo 0).
   Para o torpedo, precisa acumular ~4 turnos seus.
2. **Sem feedback quando indisponível:** botão indisponível recebe `.pu.disabled { pointer-events:none }`
   (`css/style.css:196`), então **tocar nele não faz nada** — nenhum aviso de "energia insuficiente" ou "aguarde sua vez".
   O usuário conclui que está quebrado. (O custo `⚡N` aparece no botão, mas a causa do bloqueio não.)
3. **Mira depende do toque no tabuleiro:** todo power-up (menos talvez o reparo) precisa selecionar célula(s)
   tocando o tabuleiro. Com o toque falhando (itens #1/#4), o power-up fica inutilizável **mesmo quando há energia**.

**Correção sugerida:**
- Dar feedback no toque do botão indisponível (não usar `pointer-events:none`; mostrar toast "Energia insuficiente (⚡N)" ou "Aguarde sua vez").
- Rebalancear: `ENERGY.start` = 2 (ou `perTurn` = 2), e/ou baixar custos iniciais, para os poderes aparecerem cedo.
- Resolver #1/#4 destrava a mira dos poderes.

---

## 4. 🟠 `pointertap` para atirar é frágil
**Sintoma:** Jogador 1 (Android) quase não conseguia selecionar a célula-alvo.

**Causa (🟦):** o disparo usa um único `pointertap` no container do tabuleiro (`public/js/gfx/board.js:62-67`).
O `pointertap` exige que **down e up** caiam no mesmo alvo, sem `pointercancel` no meio. Sob jank (#1) ou
num `pointercancel` do iOS (não tratado), o tap **não dispara** — daí "clicar feito louco" até um passar.

**Correção sugerida:**
- Trocar `pointertap` por `pointerdown` + `pointerup` com **tolerância de movimento** (ex.: < 16 px = tap).
- Definir um `container.hitArea` explícito (um `PIXI.Polygon` com os 4 cantos de `_project(0,0)…_project(0,1)`),
  deixando o hit-test barato e independente da ordem/preenchimento do `fillLayer`.

---

## 5. 🟡 Painéis de DOM cobrem o topo do tabuleiro
**Causa (✅):** na fase de posicionamento, `.panel-top` (`css/style.css:131`) é `position:absolute` sobre o
**topo** da área do tabuleiro e é `.glass` → `pointer-events:auto` (`style.css:39`). O `#placement-tray`
(`style.css:134-137`) cobre a faixa de baixo. O layout padrão coloca navios na **linha 0** e **linha 8**
(`placement.js:31`) — bem embaixo desses painéis, que **engolem o toque** e impedem pegar o barco.

**Correção sugerida:** deixar `#placement-header`/`.panel-top` com `pointer-events:none` (não tem botões, é só
texto) e garantir que só os itens da bandeja (`.tray-ship`) reativem o toque; ou reposicionar os painéis fora
da projeção do tabuleiro.

---

## 6. 🟡 Deadlock de animação pode congelar o tabuleiro
**Causa (🟦):** `_onBoardTap` ignora todo toque enquanto `this.animating` for `true` (`public/js/main.js:274-278`).
`animating` vira `true` em `_animateAndRender` e só volta a `false` **depois** do `await` da coreografia
(`main.js:402-412`). Essa coreografia é uma teia de `setTimeout` + callbacks de efeito (`public/js/scene.js`).
Se **um callback nunca for chamado** (um efeito falha antes de invocar o `done`), a Promise **nunca resolve**,
o `await` trava e o tabuleiro fica **permanentemente sem aceitar toque** (o `try/catch` pega exceções, mas não
uma Promise que nunca resolve).

**Correção sugerida:** `Promise.race([coreografia, timeout(3000)])` e resetar `animating` num `finally`.

---

## 7. ⚪ `clientId` compartilhado entre abas
**Causa (✅):** `getClientId()` guarda um id por origem no `localStorage` (`public/js/net.js:4-18`). Duas abas no
**mesmo** aparelho reconectam no **mesmo slot** — não dá para simular os 2 jogadores numa só máquina (dois
celulares diferentes funcionam, pois têm storage separado). Útil saber para testes.

**Correção sugerida:** permitir forçar um id novo (ex.: `?p=2`) ou usar `sessionStorage` por aba.

---

## ✅ Ordem de correção sugerida (do maior impacto pro menor)
1. **#2 + #4 + tratar `pointercancel`** — destrava posicionar barcos e atirar (o coração das queixas).
2. **#1 (qualidade reduzida no mobile)** — tira o jank que provavelmente causa #2/#4.
3. **#3 (feedback + energia)** — faz os power-ups aparecerem e explicarem-se.
4. **#5, #6, #7** — robustez e limpeza.

## 🔍 Verificação pendente
Os itens marcados com ❓ (#1) e parte de #4 dependem de **rodar num celular real** e medir FPS / observar o
console. Recomendo abrir `http://192.168.31.102:5180/?fx=low` no aparelho para testar com efeitos reduzidos —
se o toque melhorar muito, confirma o item #1 como causa principal.

> Posso implementar as correções (sugiro começar por #2/#4) ou fazer a verificação no aparelho — é só pedir.

---

## ✅ Resolução (2026-06-29)

Todas as correções são de **cliente** (nada no motor/servidor/testes/regras). Revalidado no
navegador (mobile 390×844, WebGL por software, toque sintético nos handlers reais) + LOOP A.

| # | Bug | Correção | Onde | Verificado |
|---|-----|----------|------|:--:|
| 8 | **(NOVO) Sprites/marcadores engoliam o toque nas células sob eles → Reparo impossível** | O tabuleiro virou uma **superfície única de toque**: `container.interactiveChildren = false` (só o `hitArea` do tabuleiro é alvo de ponteiro; nenhum filho — navio, marcador, overlay — intercepta). A `PlacementController` reativa `interactiveChildren` só durante o arraste. | `gfx/board.js`, `placement.js` | Reparo ponta-a-ponta: toque na célula danificada (4,2) sob o navio → cura confirmada |
| 1 | Performance trava o input no mobile | `resolution` limitada a **1.5** em ponteiro grosso (coarse); degradação automática mais agressiva (FPS<50 após 2.5 s). O conserto do toque (#2/#4) tornou o input **independente de frame**, então jank deixa de travar o gesto. | `gfx/app.js` | resolution=1.5 confirmada no mobile |
| 2 | Arraste volta ao início | Candidato semeado já no `pointerdown`; `_onUp` recalcula pela **posição de soltura** (cobre `pointermove` perdidos); `pointercancel` tratado; **pointer capture** no canvas. | `placement.js` | arraste sem `pointermove`, com `pointermove`, e `pointercancel` — todos comitam, sem drag pendurado |
| 3 | Power-ups sem feedback | Botão indisponível **continua tocável** (removido `pointer-events:none`) e explica o porquê: *"Energia insuficiente: Sonar custa ⚡2 (você tem ⚡1)"*. Dica ao selecionar cada power-up ("Toque no tabuleiro para mirar…"). | `css/style.css`, `main.js` | toast de energia + dicas confirmados |
| 4 | `pointertap` frágil pra atirar | Trocado por `pointerdown`+`pointerup` com tolerância de movimento (~1.2 célula) e `hitArea` explícito (polígono do tabuleiro). | `gfx/board.js` | toque sintético registra tiro/mira de forma confiável |
| 5 | Painel cobre o topo do tabuleiro | `#placement-header` → `pointer-events:none` (é só texto). | `css/style.css` | `pointerEvents:none` confirmado; navio da linha 0 fica pegável |
| 6 | Deadlock de animação congela o tabuleiro | `Promise.race([coreografia, timeout(5 s)])` + reset de `animating` no `finally`. | `main.js` | board nunca fica preso; taps voltam após a animação |
| 7 | `clientId` compartilhado entre abas | `?p=<n>` cria um `clientId` separado por aba (testar 2 jogadores numa máquina). | `net.js` | usado nos testes (`?p=match2` etc.) |

**Bônus de jogabilidade:** os 6 power-ups passaram de uma **fileira rolável** (botões da
direita inalcançáveis sob `touch-action:none`) para uma **grade de 6 colunas** — todos
visíveis e tocáveis sem rolar (alvos de 54×77 px no 390 px de largura).

### Rodada 2 — bugs encontrados testando em aparelho real (2 celulares)

Reproduzidos num viewport real de celular (360×800, DPR 3, toque emulado) e corrigidos:

| # | Bug | Causa raiz | Correção | Verificado |
|---|-----|-----------|----------|:--:|
| 9 | **"Só consigo mirar em alguns campos da linha 10" (P1)** — taps falham nas linhas de cima depois que navios começam a queimar | O **filtro de calor (DisplacementFilter) na `fxLayer`** passa a participar do hit-testing quando ativo e **engole os toques** destinados ao tabuleiro embaixo. Ativa quando há célula em chamas (full quality). | Camadas decorativas (`oceanLayer`/`fxLayer`/`topLayer`) marcadas `eventMode='none'` — nunca entram no hit-testing, com ou sem filtro. | round-trip **100/100** em todas as 10 linhas, full quality + calor ATIVO; 4 tiros reais na linha de cima acertam; 0 erros |
| 10 | **Mensagem "Posicione sua frota" cobre o porta-aviões** (linha 0), impedindo reposicionar | O painel ficava sobre o topo do tabuleiro. `pointer-events:none` (bug #5) deixava passar o toque, mas o painel **continuava cobrindo** o navio. Um inset FIXO clareava no emulador mas **não no celular** (entalhe/safe-area + texto da dica quebrando em 2 linhas deixam o painel mais alto). | O tabuleiro agora **mede o painel real** (`getBoundingClientRect`) e começa logo abaixo dele em qualquer aparelho (`scene._placementTopInset`). | mobile 360/320 px: margem de 31–47 px entre painel e tabuleiro (`boardClearsPanel`); confirmado visualmente |
| 11 | **Navios não pegam ao arrastar** (porta-aviões some) | A textura 2.5D do navio é alta e deslocada; o `containsPoint` do sprite não cobre a célula da quilha, então o toque caía no tabuleiro em vez do navio. | Arrastar passou a ser **por célula**: o pointerdown no tabuleiro acha o navio que ocupa a célula e o agarra (mapeamento de célula é exato, 100/100). | mobile: porta-aviões agarrado na linha 0 e movido para a linha 3 |
| 12 | **Revanche: pontos do tabuleiro anterior ficam na tela** | Ao reiniciar para o posicionamento, o tabuleiro não re-renderiza (não há `render` no posicionamento) e só os navios eram limpos — os **marcadores de acerto/água/sonar e células em chamas** da partida anterior continuavam na camada. | Novo `board.clearMarkers()` (limpa `markerLayer`/`overlayLayer`/queimando/retículo), chamado para os DOIS tabuleiros em `setPhaseView('placement')`. | injetados 3 marcas + chama nos 2 tabuleiros → após a transição de posicionamento: **0 marcas, 0 overlay, 0 chama** |

Mais robustez de mobile aplicada junto: `Cache-Control: no-store` no cliente (um *reload* sempre traz o código novo — um celular podia estar num build ANTIGO em cache), relayout no `visualViewport` (barra de endereço do mobile), e `pointercancel` tratado também no tap do tabuleiro.
