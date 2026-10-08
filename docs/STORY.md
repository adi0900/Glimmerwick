# Glimmerwick — Story, NPCs and quest chain (v1, original IP)

Tone: warm, funny, gentle; E-for-Everyone; no violence, no villains, no fail states. Every line is short (max ~140 characters per dialogue
box) so 6-12 year olds can read it. Names and places are original.

## Premise
Glimmerwick is a drifting island lit by the **Glimmerlight**, an old lighthouse whose beam keeps the island's Glimmers (the glowing
critters) happy and the nights bright. Lately the light has been **dimming**. The island needs a new **Keeper**: you. You arrive by little
boat with one backpack, to a quiet village of three empty cottages and a lot of dust.

The Glimmerlight runs on **three lenses**, one for each kind of Glimmer light. Each lens was lost in a different corner of the island.
Nobody is the villain: the lenses were simply left where the Glimmers like to nap. Friends find them, not fights.

## Cast
| Who | Role | First seen / arrives | Voice |
|---|---|---|---|
| **Pip Tumblewick** | Village mayor, tiny, round, always carrying a clipboard; welcomes you; gives the main story goals | Village green, from the start | cheerful, worried about paperwork |
| **Bram Brickle** | Builder; unlocks bigger recipes (doors, windows, roofs, lanterns); loves "load-bearing puns" | Arrives when the village has **3 buildings' worth of blocks placed** (village level 1) | gruff but soft, jokes about walls |
| **Marlo Finn** | Fisher/ferryman; unlocks the Sunken Cove route; tells Tidler stories | Arrives when you have **befriended a Tidler** | dreamy, speaks in tides |
| **Willa Bloomsby** | Gardener/forager; unlocks the Whisperwood route; knows which berries each Glimmer loves | Arrives when you have **befriended a Sprigfox** | quiet, whispers, kind |
| **Glim** (a lighthouse spirit, appears only at the end) | The Glimmerlight itself, shown as a small floating star-shaped voxel | Finale | one word at a time, sparkly |

NPCs are voxel characters built from the avatar rig (different hair, outfit colours and a hat each), idle/wander routines (water plants, sweep, read,
fish at dusk), sleep indoors at night, and show a speech bubble "!" when they have a goal for you. Pip stands on the village green;
each NPC claims one of the player-built or starting cottages as a **home** (a door the NPC walks to at night, a lit window).

## Village levels (what the world remembers)
| Level | Condition | Result |
|---|---|---|
| 0 | start | Pip + empty cottages, dim lighthouse, only Puffbun around |
| 1 | 3 buildings' worth of placed blocks near the village (20 blocks to start, 60 for level 1) | Bram moves in; wood/stone recipes expand |
| 2 | befriended Tidler **and** level 1 | Marlo moves in; paddle across the cove |
| 3 | befriended Sprigfox **and** level 2 | Willa moves in; Whisperwood path opens |
| 4 | all three lenses placed | the Glimmerlight relights; night festival; every Glimmer variant starts visiting |

## Main quest chain (each step is a goal card in the HUD, with a toast and a small reward)
**Act 1 — Arrival**
1. *Welcome, Keeper!* Talk to Pip. (Intro: the camera glides from the boat to the dim lighthouse, then to Pip.)
2. *Sawdust and Sparkle:* gather 6 wood. (Pip: "Every great village starts with a log. Or six.")
3. *Plank Plan:* craft planks at the workbench.
4. *A Roof Over Your Head:* place 20 blocks near the village green. (Pip names the first cottage as yours.)
5. *Hello, Little Light:* befriend your first Glimmer (a Puffbun) with a berry treat. The Puffbun becomes your companion and trills toward the pond.
6. *Bram Arrives:* build up to village level 1; Bram introduces himself and asks for 10 cobble for the lens pedestal.
**Act 2 — The Three Lenses**
7. *The Ripple Lens:* Pip: "Glimmers napped on the lens by the pond." Follow Puffbun to the **pond**; befriend a Tidler; it dives and surfaces with the **Ripple Lens**. Marlo arrives.
8. *The Whisper Lens:* Willa arrives after you befriend a Sprigfox in the **forest**; the Sprigfox sniffs out glowcaps that lead to the **Whisper Lens** under an old stump.
9. *The Cheer Lens:* the third lens is in the **highland meadow**; Puffbun's hop-glide (companion ability, unlocks after 3 befriended Glimmers) crosses the gap; Bram builds a little bridge for the way back.
**Act 3 — Relight**
10. *Build the Beacon:* place the three lenses on the lighthouse pedestal (a short build: climb the stair you built, place each lens).
11. *Glimmerlight Night:* the lighthouse relights; fireflies and Glimmer markings glow; all NPCs and friends gather at the village green for a festival; Glim says thanks. Credits-style toast, then the game continues in **free play** (new "Village wishes" goals: decorate, new cottages, fill the Glimmerdex).

## Companion abilities (the "unlock new areas" half of the loop)
| Friend | Ability (unlocked by befriending 1; upgrades with more friends) | Gates |
|---|---|---|
| Puffbun | **Hop-glide** (hold jump in air to float down slowly / extra hop height) | Highland ledges |
| Tidler | **Paddle boost** (faster swimming, shows safe shallows) | Cove and island shoals |
| Sprigfox | **Sniff** (hold a key: sparkle trail to the nearest hidden glowcap / treasure spot) | Hidden spots in the forest |

## Dialogue style guide
- One idea per box, 1-2 short sentences, a joke or a warm thing. No sarcasm, no scolding.
- Choices are friendly (two buttons max): "Sure!" / "Later!" — never a punishment.
- Every NPC has 6+ idle lines that rotate by time of day and village level. Use the player's name only if the player typed one.
- Lines must read well with a typewriter effect (about 40 characters per second, tap to finish).

## Sample lines
- Pip (level 0): "Oh! You're the new Keeper! I'm Pip. This is the village. It's... cosy. Dusty, but cosy."
- Pip (goal 2): "Every great village starts with a log. Or six. I'd say six."
- Bram (arrival): "Name's Bram. I build things. Mostly walls. Mostly puns about walls. They're load-bearing."
- Marlo: "The tide told me you were coming. It also told me to bring snacks."
- Willa (whisper): "Shh. The berries are shy. So are the foxes. Walk softly."
- Glim (finale): "Thank... you... Keeper. Light... home."

## Co-op later (owner's decision pending, see GAME_DESIGN.md)
Visitors use invite codes, appear as avatars with preset emotes, can help build in your village and meet your NPCs; no free-text chat.

## Data format (for the NPC/quest builder)
Quests, dialogue and NPC definitions live in data tables (TS or JSON) under `web/src/modules/story/`, not in code, so writers can edit them:
`npcs.json` (id, name, look, home, schedule, arrival condition), `quests.json` (id, title, steps, conditions, rewards, dialogue ids),
`dialogue.json` (id, speaker, text, choices, next). The HUD goal tracker from slice 1 is reused for goal cards.
