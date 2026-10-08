# Glimmerwick — Game Design (working title)

> A cozy 3D adventure for kids (and the grown-ups who play with them): befriend luminous critters called **Glimmers**,
> shape the land and build a village from chunky snap-together blocks, and live out golden days on a drifting island.

Audience: ages 6-12, "E for Everyone" tone. No violence, no chat, no accounts, no ads.
**Original IP only** — never use names, creatures, characters, music or assets from any other game or franchise.
We aim for first-party-studio polish with entirely our own IP.

## Pillars
1. **Befriend & collect** (the collecting pull) — Glimmers have species, personalities, favourite foods, habitats and
   daily schedules. You bond with them (feed, play, little mini-games) and they become companions and helpers.
   There is no combat; challenge is discovery, mastery and "Glimmer Games" (fetch races, rhythm, hide-and-seek).
2. **Build & shape anything** (the sandbox pull) — raise / lower / paint terrain; place chunky blocks and furniture
   on a snap grid; gather and craft. Everything the player makes persists.
3. **A cozy living world** (the cozy-life pull) — accelerated day/night and seasons, weather, villagers with
   routines, gentle daily goals, fishing / bug-catching / foraging, a museum-style Glimmerdex, decorating.
4. **Juice everywhere** — every action answers with motion, light, sound and a little burst of joy.

## Core loop — direction from the owner (2026-10-07; supersedes anything below that conflicts)
An open-world sandbox: **you start with a small plot of land and a basic village**, explore nearby areas, gather
resources and discover your first creatures. You spend the resources to build and upgrade the village; the creatures
you find help you unlock new areas and abilities. As the village grows, more creatures and NPCs move in and you gain
access to new biomes, resources and building options. Other players can live around you.
**explore -> collect -> build -> attract new creatures/NPCs -> unlock new areas -> repeat**, with the village constantly
evolving. Identity: sandbox building + creature collecting + cozy social life, with its own look (not a clone).
Build order (vertical slices): (1) hotbar + break/place + resource gathering + befriend/collect + Glimmerdex + HUD;
(2) village growth + first NPC + goals; (3) creature abilities that unlock biomes; (4) co-op "visit a friend's village".
Open design question (owner to decide): "other players" conflicts with the kids-safety pillars below (no chat, no accounts).
Recommended: invite-code visits, preset emotes only, no free-text chat, no public lobbies.

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
