import { createFrame, clearFrame, createFx, composite } from '/public/vendor/pixelfx/src/core/index.js';
import * as slash from '/public/vendor/pixelfx/src/fx/melee/sword-slash.js';
import * as heavySlash from '/public/vendor/pixelfx/src/fx/melee/heavy-cleave.js';
import * as blast from '/public/vendor/pixelfx/src/fx/arcane/mana-burst.js';
import * as beam from '/public/vendor/pixelfx/src/fx/arcane/arcane-beam.js';
import * as healing from '/public/vendor/pixelfx/src/fx/holy/heal-aoe.js';
import * as guard from '/public/vendor/pixelfx/src/fx/impacts/shield-block.js';
import * as qiGuard from '/public/vendor/pixelfx/src/fx/holy/divine-shield.js';
import * as blink from '/public/vendor/pixelfx/src/fx/arcane/blink-out.js';

// Small, fixed-resolution overlay; art never affects combat or game state.
const effects = {attack:slash, skill:blast, item:healing, defend:guard, flee:blink};
// The server sends only the selected move ID; gameplay never depends on these visuals.
const moveEffects = {
  slash: { action:'attack', effect:slash, anchor:'target' },
  heavy_slash: { action:'attack', effect:heavySlash, anchor:'target' },
  qi_strike: { action:'skill', effect:blast, anchor:'target' },
  qi_wave: { action:'skill', effect:beam, anchor:'actor' },
  guard_technique: { action:'defend', effect:guard, anchor:'actor' },
  guard_qi: { action:'defend', effect:qiGuard, anchor:'actor' },
};
const seen = new Set();
export function playBattleEffect(event, localId, onDone = () => {}) {
  if (!event || !event.id || seen.has(event.id) || !effects[event.action]) return false;
  const arena = document.querySelector('.battle-arena');
  if (!arena || !localId || ![event.actorId, event.targetId].includes(localId)) return false;
  const move = moveEffects[event.move];
  // A missed attack still swings, but must not show an impact on the opponent.
  const missed = event.hit === false && ['attack','skill'].includes(event.action);
  const selected = missed ? { effect:slash, anchor:'actor' } : move?.action === event.action ? move : null;
  const targetEffect = selected ? selected.anchor === 'target' : ['attack','skill'].includes(event.action);
  const subject = targetEffect ? event.targetId : event.actorId;
  const side = subject === localId ? 'player' : 'opponent';
  const anchor = arena.querySelector(`.fighter-${side}`);
  if (!anchor) return false;
  seen.add(event.id);
  if (seen.size > 200) seen.delete(seen.values().next().value);
  const canvas = document.createElement('canvas');
  canvas.width=320; canvas.height=200;
  canvas.className='battle-effect'; canvas.dataset.effectId=event.id; canvas.dataset.action=event.action;
  if (selected) canvas.dataset.move=event.move;
  canvas.setAttribute('aria-hidden','true');
  Object.assign(canvas.style, {position:'absolute',inset:'0',width:'100%',height:'100%',pointerEvents:'none',imageRendering:'pixelated',zIndex:'3'});
  arena.appendChild(canvas);
  const context=canvas.getContext('2d');
  if (!context) { canvas.remove(); onDone(); return false; }
  const frame=createFrame(canvas.width,canvas.height), image=context.createImageData(canvas.width,canvas.height);
  const ar=arena.getBoundingClientRect(), a=anchor.getBoundingClientRect();
  const x=(a.left+a.width/2-ar.left)/ar.width*canvas.width;
  const y=(a.bottom-ar.top)/ar.height*canvas.height;
  let fx;
  // Target-anchored slashes face the attacker; actor-anchored beams face the opponent.
  try { fx=createFx(selected?.effect || effects[event.action],{x,y,flip:targetEffect ? side==='player' : side==='opponent'}); }
  catch (error) { console.error('PixelFX setup failed',error); canvas.remove(); onDone(); return false; }
  const duration=Math.min(1.1,fx.meta.duration || 0.8);
  let previous=0, elapsed=0, finished=false;
  const fallback=setTimeout(() => done(), 2500);
  function done(){if(finished)return;finished=true;clearTimeout(fallback);canvas.remove();onDone();}
  function draw(now){
    if(finished)return;
    if(!canvas.isConnected) return done();
    if(!previous)previous=now;
    const dt=Math.min(.05,Math.max(0,(now-previous)/1000));previous=now;elapsed+=dt;
    try {fx.update(dt);clearFrame(frame);fx.draw(frame);composite(frame,image.data,null);context.putImageData(image,0,0);}
    catch(e){console.error('PixelFX render failed',e);return done();}
    if(elapsed>=duration)return done();
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
  return true;
}
