# Clean-room protocol (movement feel + any reference to third-party games)

Goal: get the *feel* of Minecraft-style character movement (and Cobblemon-style creature locomotion) into Glimmerwick **without using anyone's proprietary code or assets**.

## What "clean room" means here
1. **Two separate roles, never the same agent.**
   - **Analyst** — reads only PUBLIC descriptions of *observable behaviour* (community wikis, forum threads, technical write-ups, mod documentation). Writes a behavioural spec in OWN WORDS: numbers, formulas, state machines, edge cases and **test vectors**; cites URLs. Never reads or reproduces decompiled / deobfuscated / leaked source, never copies prose (wiki text is CC BY-NC-SA — facts are free, expression is not), never touches assets.
   - **Implementer** — reads ONLY our specs (`docs/specs/*.md`) and our own code. Must not browse Minecraft sources, wikis or decompilers. Ambiguity → file a spec-amendment request in `docs/REQUESTS.md`; the orchestrator relays it to an analyst.
2. **Verification by test vectors.** Every spec ends with numeric scenarios (e.g. "from rest on flat ground, hold forward N ticks → speed X"); the implementer turns them into Rust unit tests.
3. **Original expression.** Our code, names, structure and comments are our own (no Mojang names in code beyond generic words like "tick" and "block").

## Cobblemon (site https://cobblemon.com · official repo https://gitlab.com/cable-mc/cobblemon)
- Code is MPL-2.0 (file-level copyleft). **Assets** (models, animations, textures, sounds, data files) are non-commercial and Pokémon-derived IP → **never** import any asset or data file; our "original IP only" rule stands.
- Default: **study for design concepts only** (pose state machine, animation blending, head look-at, wander/navigation goals, interpolation), then write original code. Do NOT copy or mechanically translate code. Porting any code is a separate decision that needs the user's approval; ported files would have to keep MPL-2.0 headers and be listed in `docs/THIRD_PARTY.md`.

## Ledger
Everything consulted is recorded in `docs/THIRD_PARTY.md` (what, URL, licence, how used: "facts only" / "concepts only").
