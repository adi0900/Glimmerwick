/**
 * Gameplay tuning for the HUD / gather / build / befriend slice -- ONE table so it is easy to tweak.
 * (Sim-side befriending constants live in `crates/sim_creatures/src/ai.rs`, module `befriend`.)
 */
export const TUNING = {
  /** how far (m) the player can reach a block, measured from the eye along the camera direction */
  reach: 5.0,
  /** eye height above the feet (m); the avatar box is 1.15 m tall */
  eyeHeight: 0.95,
  /** the aim ray is lifted this many radians above the camera direction (the follow camera never looks up) */
  aimLift: 0.12,

  /** seconds to break a block = clamp(hardness * secondsPerHardness, breakMin, breakMax) */
  secondsPerHardness: 0.62,
  breakMin: 0.18,
  breakMax: 2.2,
  /** pause after a block broke before the next one starts (s) */
  breakRepeatDelay: 0.14,
  /** holding the place button places another block every N seconds */
  placeRepeat: 0.24,

  /** horizontal distance (m) within which E offers a treat */
  offerRange: 3.8,
  /** a creature closer than this (m) counts as "seen" for the Glimmerdex */
  dexSeenRadius: 12,

  /** avatar collision box used to refuse a placement inside the player (half width, height) */
  playerHalfWidth: 0.27,
  playerHeight: 1.2,

  hotbarSlots: 10,
  backpackSlots: 20,
  stackMax: 99,

  toastMs: 2600,
  toastMax: 4,

  /** items a new profile starts with */
  // A builder's kit so you can place blocks from the very first second (gather more by chopping trees and breaking blocks).
  starter: { cookie: 2, planks: 64, cobble: 48, plaster: 32, roof_tile: 32, glass: 16, lantern: 8, dirt: 32, log: 12 } as Record<string, number>,
  /** localStorage key (profile: inventory, dex, goal progress). v2: everyone gets the builder's kit above. */
  storageKey: 'glimmerwick.profile.v2',
} as const;
