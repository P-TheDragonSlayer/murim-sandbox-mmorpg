import { createFrame, clearFrame, createFx, composite } from '/public/vendor/pixelfx/src/core/index.js';
import * as runeCircle from '/public/vendor/pixelfx/src/fx/arcane/rune-circle.js';

// The server's channel state decides when the visual exists; effects never affect gameplay.
const palettes = {
  meditate: ['#12253b', '#23405e', '#396783', '#58a6b3', '#96d7ce', '#e9fff0'],
  medicine: ['#172919', '#284d2b', '#46864b', '#7bc679', '#c1eda4', '#f2ffe0'],
  absorb: ['#23162e', '#432455', '#70408d', '#a26ac5', '#d5a5e4', '#fff0ff'],
};
let serial = 0;
export function createChannelEffect(scene, container, kind) {
  if (!palettes[kind]) return null;
  const key = `world-channel-${++serial}`;
  const texture = scene.textures.createCanvas(key, 160, 120);
  if (!texture) return null;
  const ctx = texture.getContext();
  const frame = createFrame(160, 120);
  const image = ctx.createImageData(160, 120);
  const fx = createFx(runeCircle, { x: 80, y: 95, palette: palettes[kind] });
  const sprite = scene.add.image(-80, -95, key).setOrigin(0);
  container.addAt(sprite, 1); // circle lies behind the character
  let pending = 0, stopped = false;
  return {
    kind,
    update(delta) {
      if (stopped) return;
      pending += Math.min(delta, 100);
      if (pending < 1000 / 15) return;
      fx.update(pending / 1000); pending = 0;
      clearFrame(frame); fx.draw(frame); composite(frame, image.data, null);
      ctx.putImageData(image, 0, 0); texture.refresh();
    },
    destroy() {
      if (stopped) return;
      stopped = true; sprite.destroy(); scene.textures.remove(key);
    },
  };
}
