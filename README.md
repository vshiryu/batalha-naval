# ⚓ Batalha Naval — Comando Naval Tático

Batalha Naval com **power-ups** para **2 jogadores em rede local (LAN)**. O notebook
roda o servidor (host) e os celulares entram pelo navegador, no IP do notebook.
Visual em **WebGL (PixiJS)**: oceano animado, navios procedurais, partículas, áudio
sintetizado e HUD em vidro fosco. Servidor **autoritativo** (anti-trapaça) em
Node + Socket.IO, tudo numa **porta única**, sem build e sem assets externos.

---

## Requisitos

- **Node.js 18+** (testado no Node 20).
- Notebook e celulares na **mesma rede Wi-Fi**.
- Um navegador moderno nos celulares (WebGL).

## Instalação

```bash
npm install
```

## Como jogar (no notebook)

```bash
npm start
```

O servidor sobe e imprime as URLs no console, por exemplo:

```
══════════════════════════════════════════════════════
  ⚓  BATALHA NAVAL — servidor no ar
══════════════════════════════════════════════════════
  Local:     http://localhost:5180
  Rede (LAN): http://192.168.1.161:5180   ◄ abra este no celular
══════════════════════════════════════════════════════
```

1. Nos **dois celulares**, abra a **URL "Rede (LAN)"** (ex.: `http://192.168.1.161:5180`).
2. Os dois primeiros viram **Jogador 1** e **Jogador 2**; acessos extras entram como
   **espectador / "partida cheia"**.
3. Cada um **posiciona a frota** (arrastar, girar, ou "Aleatório") e confirma.
4. Quando ambos confirmam, começa a **batalha** em turnos alternados.

> **Porta:** o padrão é `5180` (escolhido para não colidir com outros serviços).
> Para trocar: `PORT=4000 npm start`.

> **Cair a conexão?** O jogo guarda o estado por ~60s; reabrir a mesma URL no mesmo
> celular retoma a partida de onde parou.

---

## Regras

- Tabuleiro **10×10** (colunas A–J, linhas 1–10).
- Frota: **Porta-aviões (5) · Encouraçado (4) · Cruzador (3) · Submarino (3) · Destróier (2)**.
- Turnos alternados, **1 ação por turno**. Vence quem **afundar toda a frota** inimiga.

### Energia & Power-ups

Energia começa em **0**, **+1** no início de cada turno seu e **+2** ao afundar um
navio inimigo. Usar um power-up **consome o turno**.

| Power-up | Custo | Efeito |
|---|---|---|
| Tiro Normal | 0 | Atira em 1 célula. |
| Sonar | 2 | Revela navios numa área 3×3 (reconhecimento, não afunda). |
| Salva Tripla | 3 | 3 tiros em 3 células, num único turno. |
| Torpedo de Linha | 4 | Percorre uma linha/coluna e atinge o **1º navio** do caminho. |
| Bombardeio 3×3 | 4 | Atinge as 9 células de uma área 3×3. |
| Reparo | 4 | Restaura 1 célula atingida de um navio **seu** ainda não afundado. |

### Controles (celular)

- **Tabuleiro inimigo** em destaque (onde você ataca); seu mar fica num **mini-mapa**
  no canto — toque em **👁 Espiar** para alternar.
- Selecione um power-up, **toque na célula** para mirar e confirme em **FOGO!**
  (evita tiro acidental). Botão de **mudo** sempre acessível.

---

## Anti-trapaça

Toda a lógica vive no **servidor autoritativo**. O cliente **nunca** recebe a posição
da frota inimiga — só o resultado do que descobriu (água/acerto/afundou). Cada jogador
conhece apenas a própria frota. Isso é verificado por testes automatizados (abaixo).

---

## Testes

### Motor (headless, sem navegador)

```bash
npm test            # simulação completa do motor + todos os power-ups + economia de energia
npm run test:anticheat   # varredura de anti-trapaça em 50 partidas aleatórias
npm run test:server      # fluxo ponta a ponta via Socket.IO (atribuição, turnos, reconexão, revanche)
npm run test:all         # roda os três
```

### Navegador (real, via skill `webtest`)

O motor de render exige **WebGL**. Em Chrome **headless** é preciso habilitar o
WebGL por software (o launcher padrão do `webtest` usa `--disable-gpu`, que desliga o
WebGL). Há um helper:

```bash
# 1) sobe um Chrome headless COM WebGL na porta de depuração do webtest (reusado por ele)
bash scripts/qa-chrome.sh            # 390x844 (retrato mobile) por padrão

# 2) com o servidor no ar (npm start), o webtest dirige o Jogador 1...
WT=~/.claude/skills/webtest/webtest.sh
bash "$WT" reset && bash "$WT" goto http://localhost:5180/

# 3) ...e um segundo jogador entra por um cliente Socket.IO scriptado:
node scripts/bot.js --url=http://localhost:5180 --id=bot2 --fixed --auto
```

`scripts/bot.js` é um jogador automático (posiciona, confirma e joga). Com `--fixed`
ele usa um layout determinístico e imprime as células ocupadas, útil para dirigir uma
partida completa em testes. Ele também tem um **watchdog de anti-trapaça** que aborta
se algum payload trouxer a frota inimiga.

Veja o **[TEST_REPORT.md](./TEST_REPORT.md)** para o resultado consolidado (motor + navegador)
e os screenshots de verificação visual.

---

## Estrutura

```
server/
  constants.js     # frota, custos, economia (fonte única; também enviada ao cliente)
  game-engine.js   # lógica autoritativa pura (testável, sem I/O) + estado sanitizado
  match.js         # sessões, slots P1/P2, espectador, reconexão (60s), revanche
  index.js         # Express + Socket.IO em porta única, 0.0.0.0, detecção de IP da LAN
public/
  index.html · css/style.css
  js/
    main.js        # orquestrador: rede ↔ UI ↔ cena ↔ áudio; máquina de estados; mira
    net.js · ui.js · audio.js · placement.js · constants.js
    scene.js       # ponte com a camada WebGL + coreografia das animações
    gfx/           # textures (procedural) · app · water · ships · effects · board
test/              # engine-sim · anticheat · server-flow (+ helpers)
scripts/           # bot.js (jogador scriptado) · qa-chrome.sh (Chrome WebGL p/ testes)
```

## Notas técnicas

- **Porta única**: o Express serve o cliente estático e o Socket.IO; o PixiJS vem de
  `node_modules` em `/vendor/pixi`. Sem CORS, sem dev server, sem etapa de build.
- **Zero assets externos**: navios, ícones, oceano e som são **gerados por código**
  (PixiJS Graphics, ruído procedural em canvas, síntese Web Audio).
- **Performance**: pooling de partículas e **degradação automática de efeitos** se o
  FPS cair, para manter a fluidez no celular. Fontes via Google Fonts com fallback de
  sistema (funciona offline com a fonte do sistema).
```
