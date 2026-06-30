# TEST_REPORT — Batalha Naval

**Veredito final: PASS ✅** — LOOP A (motor, headless) e LOOP B (navegador real) verdes,
incluindo a reforma visual (navios sombreados, perspectiva, radar, bloom, heat-haze).
Zero erros de console/WebSocket. Anti-trapaça verificada em duas camadas.

---

## LOOP A — Simulação do motor (headless, exaustivo)

Rodado pelo agente principal (camada mais sensível a contrato de dados). Comandos:
`npm test`, `npm run test:anticheat`, `npm run test:server` (ou `npm run test:all`).

| Suíte | Asserções | Resultado | Cobertura |
|---|---:|:--:|---|
| `engine-sim.js` | **356** | PASS | Partida COMPLETA até a vitória exercitando **todos** os power-ups; valida economia de energia contra um rastreador independente |
| `anticheat.test.js` | **22.000+** | PASS | 50 partidas aleatórias; a cada ação, varre o payload dos dois clientes |
| `server-flow.js` | **37** | PASS | Fluxo Socket.IO ponta a ponta (atribuição, espectador, turnos, anti-trapaça na rede, reconexão, revanche) |

Comportamentos asseverados com valores exatos:
- **Energia**: início 0; **+1** no começo de cada turno do jogador; **+2** ao afundar — conferido turno a turno por um rastreador independente ao longo de uma partida inteira.
- **Custos** respeitados e ações sem energia rejeitadas (`insufficient_energy`).
- **Sonar** (2): revela navios numa 3×3 **sem causar dano** (tabuleiro inimigo intacto; descoberta permanente não acontece).
- **Salva Tripla** (3): exatamente **3 tiros** resolvidos num único turno.
- **Torpedo** (4): atinge a **primeira** célula com navio na linha/direção; **erra** (impact null) quando não há navio.
- **Bombardeio** (4): resolve as **9 células** da área 3×3.
- **Reparo** (4): restaura uma célula atingida de um navio próprio não afundado; o oponente **perde** o acerto confirmado (reverte para "desconhecido").
- **Vitória** ao afundar a frota inteira; nenhuma ação aceita após o fim.
- **Turnos**: ação fora da vez rejeitada (`not_your_turn`); célula repetida rejeitada.

### Anti-trapaça (nível servidor)
Para todo `publicStateFor(slot)`: `enemy.fleet/ships/grid` **ausentes**; a `view` só contém
células efetivamente descobertas; **nenhuma** célula de navio não-descoberta vaza; o tipo do
navio só é revelado **ao afundar** (acerto que não afunda não revela o tipo). Varredura
profunda do JSON confirma que a lista de células da frota inimiga nunca aparece no payload.

---

## LOOP B — Navegador real (delegado a subagente de QA, skill `webtest`)

Viewport de celular **390×844**, Chrome headless com **WebGL por software** (SwiftShader).
Jogador 1 dirigido pela `webtest`; Jogador 2 por cliente Socket.IO scriptado
(`scripts/bot.js`, com watchdog de anti-trapaça embutido). Partida determinística de
vitória via `--fixed` (o driver conhece o layout pelo lado do bot; **o cliente nunca
recebe a frota inimiga** — anti-trapaça preservada).

| Área | Resultado |
|---|:--:|
| Lobby carrega + papel (Jogador 1/2) + "aguardando oponente" | PASS |
| Canvas WebGL renderiza (lobby, posicionamento, acerto, afundamento, sonar, vitória) | PASS |
| Posicionamento: arrastar, girar, aleatório, validação (rejeita sobreposição/fora) | PASS |
| Transições de tela | PASS |
| Tiro normal: água / acerto / afundou refletindo nos dois lados | PASS |
| Sonar · Salva Tripla · Torpedo · Bombardeio · Reparo (usados em partida real) | PASS |
| Gating de power-up (desabilitado sem energia / fora da vez) | PASS |
| Atribuição P1/P2; 3º acesso = espectador / "partida cheia" | PASS |
| Turnos alternados (não dá pra agir fora da vez) | PASS |
| Vitória declarando o vencedor correto | PASS |
| Revanche reiniciando com ambos conectados (inclui 2ª partida completa) | PASS |
| Reconexão (recarregar na carência) retomando o estado | PASS |
| Anti-trapaça via `eval` no cliente (`enemy.fleet` undefined; view nunca vaza) | PASS |
| Watchdog de anti-trapaça do bot (nunca disparou) | PASS |
| `assert-no-errors --strict` (zero erros de console/JS/WebSocket) | PASS |

### Bug encontrado e corrigido (1)
- **Trava da tela de fim após revanche.** `_renderEnd` agendava um `setTimeout` de revelação
  da tela de fim que nunca era cancelado; quando a revanche reiniciava para o posicionamento
  em menos de 1,4 s, o timer obsoleto cobria a tela de posicionamento e travava o jogador.
  **Correção (na fonte, `public/js/main.js`):** o timer é cancelado em toda mudança de fase
  (`clearTimeout(this._endTimer)` no topo de `_onPhaseChange`); a tela de fim é armada uma
  única vez na fase `finished` com guarda `if (this.state.phase !== 'finished') return;`;
  `_renderEnd` passou a só atualizar o texto do status da revanche.
  **Revalidado pelo QA: PASS** (caminho rápido de revanche cai no posicionamento; 2ª partida
  jogada até a vitória; zero erros).

Nenhum outro defeito de produto encontrado.

---

## Reforma visual (rodada 2) — navios, perspectiva e FX

Após a v1, a UI foi repaginada: navios **sombreados em canvas** (gradiente, oclusão,
rim-light do time, detalhe por classe), tabuleiro em **perspectiva leve**, varredura de
**radar**, **retículo de mira que trava**, "bloom" aditivo, **fogo com heat-haze**, espuma
nos navios e brilho especular na água. O motor/servidor não mudaram (LOOP A segue verde).

Um defeito foi encontrado e corrigido **por mim no auto-teste** antes do QA: o canhão de ré
(`dir=-1`) desenhava o cano com largura negativa, e `roundRect` derivava um raio negativo →
`arcTo` lançava exceção, deixando 3 classes de navio invisíveis. Corrigido em
`public/js/gfx/ships.js` (largura sempre positiva + clamp do raio).

Revalidação do QA no navegador (`?fx=high`, 390×844) — **PASS, sem bugs de produto:**

| Verificação | Resultado |
|---|:--:|
| 5 navios sombreados renderizam no posicionamento | PASS |
| **Precisão do toque sob perspectiva** (projeção inversa) | PASS — round-trip exato nas 100 células; toques fora-de-centro e tiros reais em linhas longe/meio/perto acertam a célula exata, sem "vazar" pra vizinha |
| Radar girando · retículo travando · bloom · fogo+heat-haze · espuma · wreck | PASS (todos renderizam) |
| Regressão: sonar (sem dano) · bombardeio 3×3 · torpedo (1º navio) · vitória | PASS |
| Anti-trapaça (eval no cliente + watchdog do bot) | PASS |
| `assert-no-errors --strict` | PASS — zero erros |
| Modo reduzido (`?fx=low`) ainda renderiza | PASS |

Screenshots da reforma em [`screenshots/`](./screenshots): `v2-01-lobby` · `v2-02-ships-perspective`
· `v2-03-radar-sweep` · `v2-04-lockon-reticle` · `v2-05-explosion-bloom` · `v2-06-fire-heathaze`
· `v2-07-wreck-reveal` · `v2-08-bombard` · `v2-09-victory` · `v2-10-reduced-fx`.

---

## Screenshots de verificação visual

Em [`screenshots/`](./screenshots) (capturados em 390×844, todos com o canvas WebGL
renderizado — nenhum em branco):

| Arquivo | Cena |
|---|---|
| `01-lobby.png` | Lobby: oceano animado, título, grade tática |
| `02-placement.png` | Posicionamento: navios procedurais, bandeja, controles |
| `03-battle.png` | Batalha: tabuleiro inimigo, mini-mapa próprio, HUD, energia, power-ups |
| `04-hit.png` | Acerto: marcador de fogo na célula |
| `05-sink.png` | Afundamento: destroços + bônus de energia |
| `06-sonar.png` | Sonar: varredura 3×3 com 3 contatos detectados |
| `07-torpedo.png` | Torpedo: controles de linha/sentido + impacto |
| `08-triple.png` | Salva Tripla: 3 acertos no mesmo turno |
| `09-bombard.png` | Bombardeio: 3×3 (acertos no centro + água ao redor) |
| `10-repair.png` | Reparo: foco no próprio mar, alvo de célula danificada |
| `11-victory.png` | Vitória: "VITÓRIA" dourado + flares |
| `12-reconnection.png` | Reconexão: batalha retomada com o mesmo estado |
| `13-rematch.png` | Revanche (caminho rápido): cai no posicionamento — bug corrigido |
| `14-reduced-effects.png` | Modo de efeitos reduzidos (`?fx=low`) ainda renderiza |

---

## Correções de jogabilidade no celular (rodada 3) — `BUGS.md`

Reportado em aparelhos reais: J1 (Android) quase não conseguia tocar para atirar; J2
(iPhone) não conseguia posicionar (navios voltavam ao início); **ambos não usavam nenhum
power-up, mesmo com energia**. Os 8 bugs (7 do `BUGS.md` + 1 descoberto na revalidação)
foram corrigidos **só no cliente** — motor/servidor/regras/testes intactos (LOOP A segue
**356 / 22.715 / 37**, 0 falhas).

**Bug crítico descoberto na revalidação:** os sprites de navio e marcadores de acerto
**interceptavam o toque nas células sob eles**, então o **Reparo** (cujo alvo é sempre uma
célula danificada do próprio navio) era **impossível** — a causa real do *"não usei nenhum
poder"*. Correção: o tabuleiro virou uma superfície única de toque
(`container.interactiveChildren = false`; só o `hitArea` recebe ponteiro), com a
`PlacementController` reativando a interação dos filhos apenas durante o arraste.

Revalidação no navegador (mobile **390×844**, WebGL por software, **eventos de ponteiro
sintéticos exercitando os handlers reais**):

| Verificação | Resultado |
|---|:--:|
| Arraste: comita pela posição de soltura mesmo **sem `pointermove`** (bug do "volta ao início") | PASS |
| Arraste com movimento · `pointercancel` não deixa drag pendurado · girar | PASS |
| Toque pra atirar via `pointerdown`+`pointerup` (substitui `pointertap` frágil) | PASS |
| **6 power-ups ponta-a-ponta**: Tiro · Sonar · Salva Tripla · Torpedo · Bombardeio · **Reparo** | PASS |
| Feedback de power-up indisponível (toast "Energia insuficiente ⚡N") + dicas de mira | PASS |
| Grade de power-ups: **6 botões visíveis sem rolagem** (390 px; alvos 54×77 px) | PASS |
| `resolution` limitada a **1.5** em ponteiro grosso (mobile) | PASS |
| `#placement-header` com `pointer-events:none` (não rouba o toque do topo) | PASS |
| Reconexão (recarregar no meio da batalha) retoma o estado | PASS |
| `assert-no-errors --strict` (console/JS/WebSocket) | PASS — zero |

Screenshot: [`screenshots/v3-mobile-battle-powerups.png`](./screenshots) — batalha em 390×844
com os 6 power-ups numa fileira só.

### Rodada 2 (teste em 2 aparelhos) — 3 bugs a mais, reproduzidos e corrigidos

Testando em celulares reais surgiram 3 defeitos não visíveis no emulador, todos reproduzidos
num viewport real (360×800, DPR 3, toque emulado) e corrigidos:

- **🔴 "Só dá pra mirar em alguns campos da linha 10".** O **filtro de calor
  (DisplacementFilter) na camada de FX** passa a participar do hit-testing quando ativo
  (após um navio começar a queimar, em qualidade cheia) e **engole os toques** do tabuleiro.
  Reproduzido: round-trip caía para **39/100** (só as linhas de baixo respondiam) com o calor
  ativo. **Correção:** camadas decorativas (oceano/FX/topo) com `eventMode='none'` — fora do
  hit-testing. **Revalidado: 100/100 em todas as 10 linhas, qualidade cheia + calor ATIVO,**
  4 tiros reais na linha de cima acertando, 0 erros de console.
- **🟡 Painel "Posicione sua frota" cobria o porta-aviões.** Um inset fixo clareava no
  emulador mas não no celular (entalhe/safe-area + dica quebrando em 2 linhas). O tabuleiro
  agora **mede o painel real** e começa logo abaixo dele (margem de 31–47 px a 360/320 px;
  confirmado visualmente).
- **🟠 Navios não pegavam ao arrastar** (a textura 2.5D não cobre a célula da quilha). Agarrar
  virou **por célula** (mapeamento exato): verificado agarrando o porta-aviões na linha 0 e
  movendo para a linha 3.
- **🟡 Revanche deixava pontos do tabuleiro anterior na tela.** No posicionamento o tabuleiro
  não re-renderiza, então marcadores/chama da partida anterior ficavam. Novo `clearMarkers()`
  chamado para os dois tabuleiros na transição de posicionamento (verificado: 3 marcas + chama
  → 0 após a transição).

Robustez extra: `Cache-Control: no-store` no cliente (reload sempre traz o build novo — um
celular podia estar com código ANTIGO em cache, o que reproduz o sintoma original do bug #4),
relayout no `visualViewport` e `pointercancel` tratado no tap do tabuleiro.

---

## Como reproduzir

```bash
npm install
npm run test:all                  # LOOP A (motor + anti-trapaça + rede)
npm start                         # sobe o servidor (imprime a URL da LAN)

# LOOP B (navegador):
bash scripts/qa-chrome.sh         # Chrome headless COM WebGL (390x844) na porta do webtest
WT=~/.claude/skills/webtest/webtest.sh
bash "$WT" reset && bash "$WT" goto http://localhost:5180/
node scripts/bot.js --url=http://localhost:5180 --id=bot2 --fixed --auto
```

## Performance
Pooling de partículas e **degradação automática de qualidade**: se o FPS médio cair abaixo
de ~45, a cena desliga o filtro de displacement da água, o blur das grades e reduz a contagem
de partículas (uma vez, sem oscilar). Override manual para aparelhos antigos: abrir com
`?fx=low`. Verificado: `quality:'full'` → filtros ativos; `?fx=low` → `quality:'reduced'`,
filtros removidos, 0 erros.
