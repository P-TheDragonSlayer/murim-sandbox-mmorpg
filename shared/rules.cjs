'use strict';

const COMBAT_MOVES = require('./combat-moves.json');
const DEFAULT_MOVES = {attack:'slash', skill:'qi_strike', defend:'guard_technique'};

// Prototype tuning; authoritative server validates turn order and persists outcomes.
const MAX_MERIDIAN_DAMAGE = 80;
const n = (value, fallback) => Number.isFinite(value) ? value : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function createFighter(input = {}) {
  const maxHp = Math.max(1, n(input.maxHp, 100));
  const qiMax = Math.max(1, n(input.qiMax, 100));
  const injury = clamp(n(input.meridianDamage, 0), 0, MAX_MERIDIAN_DAMAGE);
  const maxQi = qiMax * (1 - injury / 100);
  const hp = clamp(n(input.hp, maxHp), 0, maxHp);
  return {
    ...input, id: input.id, name: input.name || 'จอมยุทธ์', maxHp, hp,
    qiMax, qi: clamp(n(input.qi, maxQi), 0, maxQi),
    power: Math.max(1, n(input.power, 10)), dead: Boolean(input.dead) || hp <= 0,
    inventory: { potion: Math.max(0, n(input.inventory?.potion, 2)), medicine: Math.max(0, n(input.inventory?.medicine, 1)) },
    meridianDamage: injury, defending: Boolean(input.defending),
    defenseType: input.defending && ['attack','skill','all','dodge'].includes(input.defenseType) ? input.defenseType : 'all',
    poison: Math.max(0, Math.floor(n(input.poison, 0))),
    cultivation: Math.max(0, n(input.cultivation, 0)),
  };
}

function copy(fighter) { return fighter == null ? null : createFighter(fighter); }
function finishDamage(target, amount) {
  const damage = Math.max(0, Math.round(amount));
  target.hp = Math.max(0, target.hp - damage);
  if (target.hp === 0) target.dead = true;
  return damage;
}

// Turn ownership, range, and transitions are checked by the caller.
function validateAction({actor, target, action = {}}) {
  if (!actor || actor.dead) return {ok:false, log:'ตัวละครไม่สามารถต่อสู้ได้'};
  const type = action.type;
  if (!['attack', 'skill', 'defend', 'flee', 'item'].includes(type)) return {ok:false, log:'คำสั่งไม่ถูกต้อง'};
  if (['attack', 'skill'].includes(type) && (!target || target.dead || actor.id === target.id)) return {ok:false, log:'เป้าหมายไม่ถูกต้อง'};
  let move, moveId;
  if (['attack', 'skill', 'defend'].includes(type)) {
    moveId = action.move === undefined ? DEFAULT_MOVES[type] : action.move;
    move = typeof moveId === 'string' && Object.hasOwn(COMBAT_MOVES, moveId) ? COMBAT_MOVES[moveId] : null;
    if (!move || move.action !== type) return {ok:false, log:'กระบวนท่าไม่ถูกต้อง'};
    if (actor.qi < move.cost) return {ok:false, log:'ปราณไม่พอ'};
  } else if (action.move !== undefined) return {ok:false, log:'กระบวนท่าไม่ถูกต้อง'};
  if (type === 'item' && (!['potion', 'medicine'].includes(action.item) || actor.inventory?.[action.item] < 1)) return {ok:false, log:'ไม่มีไอเทมที่ใช้'};
  return {ok:true, move, moveId};
}

// 2d20 check difficulty, adjusted by the ratio of combat power. A higher
// acting fighter power can never increase the target, and a stronger opponent
// can never reduce it. Both results remain possible at the extremes.
function diceTarget(actor, target, moveId) {
  const difficulty = {slash:19,heavy_slash:23,qi_strike:20,qi_wave:22,guard_technique:19,guard_qi:20,dodge:22};
  if (!Object.hasOwn(difficulty, moveId)) return null;
  const own = Math.max(1, n(actor?.power,10)), enemy = Math.max(1,n(target?.power,10));
  const adjustment = Math.floor(2 * Math.log2(own / enemy));
  return clamp(difficulty[moveId] - adjustment, 6, 36);
}

function resolveAction({ actor: input, target: opponent, action = {}, rng = Math.random, rollSuccess }) {
  const actor = copy(input), target = copy(opponent);
  const out = { actor, target, ok: false, escaped: false, log: '' };
  const type = action.type;
  const valid = validateAction({actor,target,action});
  if (!valid.ok) return { ...out, log:valid.log };
  const {move, moveId} = valid;

  actor.defending = false;
  actor.defenseType = 'all';
  if (actor.poison > 0) {
    finishDamage(actor, 5);
    actor.poison -= 1;
    if (actor.dead) return { ...out, ok: true, actionCancelled:true, hit:false, log: `${actor.name} ถูกพิษจนสิ้นชีวิต` };
  }
  if (type === 'defend') {
    actor.qi -= move.cost;
    actor.defending = rollSuccess !== false;
    actor.defenseType = actor.defending ? move.defense : 'all';
    out.log = `${actor.name} ใช้${move.name}${actor.defending ? ' สำเร็จ' : ' แต่พลาด'}`;
  } else if (type === 'flee') {
    out.escaped = rng() < 0.5;
    out.log = out.escaped ? `${actor.name} หลบหนีสำเร็จ` : `${actor.name} หลบหนีไม่สำเร็จ`;
  } else if (type === 'item') {
    actor.inventory[action.item] -= 1;
    if (action.item === 'potion') {
      actor.hp = Math.min(actor.maxHp, actor.hp + 35);
      out.log = `${actor.name} ใช้ยารักษา`;
    } else {
      actor.meridianDamage = Math.max(0, actor.meridianDamage - 25);
      actor.qi = Math.min(actor.qiMax * (1 - actor.meridianDamage / 100), actor.qi + 20);
      out.log = `${actor.name} ใช้ยาบำรุงเส้นปราณ`;
    }
  } else {
    actor.qi -= move.cost;
    if (rollSuccess === false || (rollSuccess === undefined && move.accuracy < 1 && rng() >= move.accuracy)) {
      out.hit = false;
      out.log = `${actor.name} ใช้${move.name} แต่พลาด`;
    } else {
      out.hit = true;
      const dodged = target.defending && target.defenseType === 'dodge';
      const defense = dodged ? 0 : target.defending ? (target.defenseType === 'all' || target.defenseType === type ? 0.5 : 0.8) : 1;
      const damage = finishDamage(target, actor.power * move.multiplier * defense);
      target.defending = false;
      target.defenseType = 'all';
      if (dodged) { out.hit = false; out.dodged = true; }
      out.log = dodged ? `${target.name} หลบ${move.name}ได้สำเร็จ` : `${actor.name} ใช้${move.name} ${target.name} เสียพลังชีวิต ${damage}`;
    }
  }
  out.move = moveId || null;
  out.ok = true;
  return out;
}

// Caller must enforce channel duration, consume medicine when beginning, and
// atomically claim corpse qi once before applying the returned state.
function resolveChannel({ actor: input, kind, interrupted = false, amount = 0 }) {
  const actor = copy(input);
  const out = { actor, ok: false, absorbed: 0, log: '' };
  if (!actor || actor.dead || !['meditate', 'medicine', 'absorb'].includes(kind)) return { ...out, log: 'ไม่สามารถรวบรวมปราณได้' };
  if (interrupted) {
    actor.meridianDamage = Math.min(MAX_MERIDIAN_DAMAGE, actor.meridianDamage + 20);
    actor.qi = Math.min(actor.qi, actor.qiMax * (1 - actor.meridianDamage / 100));
    return { ...out, ok: true, log: 'ถูกขัดจังหวะ เส้นปราณเสียหาย ต้องใช้ยาบำรุง' };
  }
  if (kind === 'absorb') {
    out.absorbed = Math.max(0, n(amount, 0));
    actor.cultivation += out.absorbed;
    out.log = `ดูดซับพลังปราณ ${out.absorbed}`;
  } else if (kind === 'medicine') {
    actor.meridianDamage = Math.max(0, actor.meridianDamage - 25);
    actor.qi = Math.min(actor.qiMax * (1 - actor.meridianDamage / 100), actor.qi + 20);
    out.log = 'ยาบำรุงฟื้นฟูเส้นปราณ';
  } else {
    actor.qi = Math.min(actor.qiMax * (1 - actor.meridianDamage / 100), actor.qi + 15);
    out.log = 'นั่งสมาธิฟื้นปราณ';
  }
  out.ok = true;
  return out;
}

function computeCorpseQi(qiAtDeath, createdAt, now, ttlMs = 60000) {
  if (![qiAtDeath, createdAt, now, ttlMs].every(Number.isFinite) || ttlMs <= 0) return 0;
  return Math.max(0, qiAtDeath) * 0.5 * clamp(1 - Math.max(0, now - createdAt) / ttlMs, 0, 1);
}

function weightedSelect(entries, rng = Math.random) {
  const valid = (Array.isArray(entries) ? entries : []).filter(e => e && e.id != null && Number.isFinite(e.damage) && e.damage > 0);
  const total = valid.reduce((sum, e) => sum + e.damage, 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  let roll = clamp(n(rng(), 0), 0, 1 - Number.EPSILON) * total;
  for (const entry of valid) { roll -= entry.damage; if (roll < 0) return entry.id; }
  return valid[valid.length - 1].id;
}

module.exports = { createFighter, validateAction, diceTarget, resolveAction, resolveChannel, computeCorpseQi, weightedSelect };
