# 🐛 Batalha Naval — Relatório de Bugs (teste em celulares)

> Gerado em 2026-06-28 a partir de uma leitura completa do código (cliente, servidor e
> da fonte do PixiJS 7.4.3 instalado). Os bugs de **toque/arraste** ainda precisam de
> confirmação rodando num aparelho real — veja a seção [Verificação pendente](#-verificação-pendente).

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
