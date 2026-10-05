# Glimmerwick — Game Design (working title)

> A cozy 3D adventure for kids (and the grown-ups who play with them): befriend luminous critters called **Glimmers**,
> shape the land and build a village from chunky snap-together blocks, and live out golden days on a drifting island.

Audience: ages 6-12, "E for Everyone" tone. No violence, no chat, no accounts, no ads.
**Original IP only** — never use names, creatures, characters, music or assets from Nintendo / Game Freak / Mojang / anyone else.
We match their *polish tier*, never their IP.

## Pillars (what we are matching)
1. **Befriend & collect** (the Pokémon pull) — Glimmers have species, personalities, favourite foods, habitats and
   daily schedules. You bond with them (feed, play, little mini-games) and they become companions and helpers.
   There is no combat; challenge is discovery, mastery and "Glimmer Games" (fetch races, rhythm, hide-and-seek).
2. **Build & shape anything** (the Minecraft pull) — raise / lower / paint terrain; place chunky blocks and furniture
   on a snap grid; gather and craft. Everything the player makes persists.
3. **A cozy living world** (the Animal Crossing pull) — accelerated day/night and seasons, weather, villagers with
   routines, gentle daily goals, fishing / bug-catching / foraging, a museum-style Glimmerdex, decorating.
4. **Juice everywhere** — every action answers with motion, light, sound and a little burst of joy.

## Loops
- ~30 s: notice something (critter, sparkle spot, fishing ripples) → approach → interact → juicy reward.
- ~10 min: finish 1-2 gentle goals (befriend X, build Y, deliver Z) → unlock something you can *see*
  (block, recipe, area, outfit, villager).
- Days/weeks: fill the Glimmerdex (target 60 species × colour variants), grow the village, meet villagers,
  seasonal events, decorate, uncover the island's story.

## Systems → owners
| System | Rust crate | Notes |
|---|---|---|
| World, terrain, biomes, water, terraforming | `sim_world` | island chain, heightfield, biome map, placement maps |
| Player: controller, tools, inventory | `sim_player` | camera-relative movement, swim, jump, tools (net, rod, shovel, axe, watering can) |
| Glimmers: species, AI, needs, bonding, dex | `sim_creatures` | data-driven species table; utility AI; habitats; schedules |
| Building & crafting | `sim_build` | snap-grid blocks/furniture, recipes, persistence |
| Time, weather, economy, quests, villagers, save/load, entitlements | `sim_systems` | accelerated day (~24 real-minutes/day), 4 seasons |

## Ethical monetization (non-negotiable)
Premium one-time purchase + optional **cosmetic-only** packs (outfits, house styles, music) behind a parent gate.
Prices always visible. No randomized paid rewards, no timers / FOMO / streak guilt, no pay-to-win, no ads, no
manipulative nudges. Spending is never required and never changes gameplay power. Local saves only; no personal
data (COPPA / GDPR-K friendly). The shop is a quiet "Peddler's cart" screen that never interrupts play.
We want kids to *love* the game, not feel pressured by it. (Engagement comes from delight, mastery, creativity, collection.)

## Milestone 1 — "Hero slice"
One island at day / sunset / night with sea, cliffs, beach, meadow, forest and a pond; a controllable player with a
polished camera; three Glimmer species that wander, notice you and emote; grass / trees / flowers / rocks; a real
day-night cycle and weather; title screen + HUD skeleton. Everything in it must pass the critic bar in `QUALITY_BAR.md`.
