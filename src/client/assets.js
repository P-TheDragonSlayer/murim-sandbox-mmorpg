// Pixel asset contract: set a local spritesheet URL and matching frame dimensions.
// Layers share frame numbers and pivots, so equipment remains aligned in animation.
// Null URLs retain the procedural placeholder; no artwork is required.
export const CHARACTER_LAYERS = [
  { key: 'body', url: null, frameWidth: 64, frameHeight: 64, originX: 0.5, originY: 1, scale: 1, depth: 1 },
  { key: 'clothing', url: null, frameWidth: 64, frameHeight: 64, originX: 0.5, originY: 1, scale: 1, depth: 2 },
  { key: 'weapon', url: null, frameWidth: 64, frameHeight: 64, originX: 0.5, originY: 1, scale: 1, depth: 3 },
];
// Shared frame ranges apply to every layer. All sheets must use identical layouts.
export const CHARACTER_ANIMATIONS = {
  idle: { start: 0, end: 0, frameRate: 1 },
  walk: { start: 1, end: 4, frameRate: 8 },
};

// Optional transparent PNG portraits for the separate battle screen.
// Null keeps the built-in placeholders. Images are shared by all characters for now.
export const WORLD_ART = {
  player: '/public/art/characters/murim-wanderer-v1.png',
  dummy: '/public/art/characters/training-dummy-v1.png',
};
export const BATTLE_ART = { player: WORLD_ART.player, opponent: WORLD_ART.player, dummy: WORLD_ART.dummy };
