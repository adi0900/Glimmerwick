# Quality Bar & Critic Protocol

**The test:** show a parent and a 9-year-old a still from our game next to a still from a flagship Nintendo / Game Freak title.
They should not be able to tell instantly which one is the indie. We match the *polish tier* (cohesion, lighting, materials,
charm, animation, feedback) of Pokémon Legends: Arceus / Scarlet-Violet, Animal Crossing: New Horizons and Minecraft — with original IP.

## Rubric (integers 0-10; calibrate harshly; score only what you can SEE in screenshots you captured yourself)
| axis | what it means |
|---|---|
| 1 Art direction & cohesion | one confident style; palette discipline; nothing looks "from a different game" |
| 2 Lighting & colour | warm/cool contrast, hue-shifted shadows, depth, mood, time-of-day beauty |
| 3 Materials & texture | hand-painted richness, no tiling, no flat plastic, micro-detail up close |
| 4 Shape & modelling | silhouettes, proportions, bevels, charm, appeal; no primitives-glued-together look |
| 5 Animation & motion | squash/stretch, anticipation, overshoot, secondary motion, life in idles (judge from filmstrips) |
| 6 Rendering polish | AA, shadows, AO, no shimmer/acne/z-fight/pop-in/banding/aliasing; stable |
| 7 Composition & readability | clear focal point, value structure, nothing cluttered or muddy |
| 8 Delight & juice | VFX, feedback, "I want to poke it" factor |
| 9 Performance | meets budgets in ARCHITECTURE.md §7 (use tool stats) |

Anchors: **10** indistinguishable from first-party Nintendo/Game Freak shipping stills · **9** could appear in their trailers without
embarrassment · 8 top-tier indie/AA hit · 7 good indie · 6 competent hobby project · 4 prototype · 2 tech demo.
**PASS = every applicable axis ≥ 9 AND the blind A/B (when refs exist) is won or called too-close.** Anything else is FAIL.

## Critic obligations (a critic is a separate agent from the builder; independence is the point)
1. Capture your own evidence: run the module's shot pack yourself (`node tools/shot.mjs --pack <module> --round N`) — never trust builder-supplied images.
2. View ≥ 6 distinct shots: ≥ 1 wide, ≥ 2 extreme close-ups, ≥ 2 times of day, ≥ 1 moving filmstrip (`--filmstrip 8 --interval 120`), plus **2 cameras you choose yourself** (the builder may hide weaknesses in presets). Crop/zoom into suspicious areas (`--crop --zoom`).
3. Name specific benchmark comparisons ("Animal Crossing's grass reads as X; ours reads as Y because …"). Do not score ≥ 9 on an axis unless you can name what the flagship does and show ours matches it.
4. Never grade on effort, difficulty or "it's procedural / in a browser". Score the pixels. Don't soften between rounds; re-score from scratch.
5. Output: (a) markdown critique with the **top 5 defects** ranked by visual impact — each = where (shot + region), why it reads as non-AAA, concrete fix hints (technique + parameter ranges); (b) JSON verdict
   `{"module","round","scores":{"1":n,…"9":n},"pass":bool,"top_defects":[…],"plateau":bool}` saved to `docs/critiques/<module>/round-N.json` and the markdown to `round-N.md`.
6. Be constructive-brutal: say exactly what would make the next round better. No flattery, no padding.

## Blind A/B (needs reference screenshots in `reference/` — user-supplied; git-ignored)
`node tools/ab.mjs make --ours shots/x.png --ref random --id a1` → writes `ab/a1.png` (ours vs. a random reference, **random left/right**, same size/crop) and a sealed `ab/a1.key.json`.
The critic looks ONLY at `ab/a1.png`, states which side is better and why (and which looks like the commercial title), *then* runs `node tools/ab.mjs reveal --id a1 --pick left|right`, which logs to `docs/ab_results.json`.
Need ≥ 5 trials over different scenes; ours must win a majority (or critic says too-close) for A/B to count as passed. No refs → log "no refs", rubric-only.

## Round policy (per module; orchestrator runs it)
builder → critic → builder (same agent, continued with the critique) → critic … Up to **6 rounds**. Stop early on PASS.
**Plateau rule:** if the critic's top-3 defects repeat for 2 consecutive rounds, escalate to the orchestrator with an alternative technique (or asset-generation help) instead of grinding.
Integration Director (a separate critic) later scores the *combined* game with the same rubric; module PASS does not imply game PASS.
The orchestrator reports scores honestly — a module that has not reached the bar is reported as not reached.
