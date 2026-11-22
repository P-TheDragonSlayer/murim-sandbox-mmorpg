'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFighter, resolveAction, resolveChannel, computeCorpseQi, weightedSelect } = require('../shared/rules.cjs');

test('attack damages only the copy and lethal damage marks target dead', () => {
  const actor = createFighter({id: 'a', power: 12});
  const target = createFighter({id: 'b', hp: 10});
  const result = resolveAction({ actor, target, action: {type: 'attack'} });
  assert.equal(result.target.dead, true);
  assert.equal(result.target.hp, 0);
  assert.equal(target.hp, 10);
  assert.equal(target.dead, false);
});
test('guard halves next hit and skill consumes qi', () => {
  const actor = createFighter({id:'a', power:10});
  const target = createFighter({id:'b', defending:true});
  const result = resolveAction({actor, target, action:{type:'skill'}});
  assert.equal(result.actor.qi,80);
  assert.equal(result.target.hp,91);
  assert.equal(result.target.defending,false);
});
test('invalid action and unaffordable skills do not consume a turn or mutate', () => {
  const actor = createFighter({id:'a', qi:0, poison:2});
  const target = createFighter({id:'b'});
  const result = resolveAction({actor,target,action:{type:'skill'}});
  assert.equal(result.ok,false);
  assert.equal(result.actor.hp,100);
  assert.equal(result.actor.poison,2);
});
test('selected moves apply server-defined damage, qi and accuracy', () => {
  const actor = createFighter({id:'a', power:10}), target = createFighter({id:'b'});
  const wave = resolveAction({actor,target,action:{type:'skill',move:'qi_wave'}});
  assert.equal(wave.target.hp,76); assert.equal(wave.actor.qi,65); assert.equal(wave.move,'qi_wave');
  const hit = resolveAction({actor,target,action:{type:'attack',move:'heavy_slash'},rng:()=>0.74});
  assert.equal(hit.target.hp,86);
  const miss = resolveAction({actor,target,action:{type:'attack',move:'heavy_slash'},rng:()=>0.75});
  assert.equal(miss.target.hp,100); assert.match(miss.log,/พลาด/);
  const invalid = resolveAction({actor,target,action:{type:'attack',move:'qi_wave'}});
  assert.equal(invalid.ok,false); assert.equal(invalid.actor.qi,100); assert.equal(invalid.target.hp,100);
});
test('specialized defenses persist and reduce the next matching attack more strongly', () => {
  const defender=createFighter({id:'a',qi:30}), attacker=createFighter({id:'b',power:10});
  const qiGuard=resolveAction({actor:defender,target:attacker,action:{type:'defend',move:'guard_qi'}});
  assert.equal(qiGuard.actor.qi,20); assert.equal(qiGuard.actor.defenseType,'skill');
  const matching=resolveAction({actor:attacker,target:qiGuard.actor,action:{type:'skill',move:'qi_strike'}});
  assert.equal(matching.target.hp,91); assert.equal(matching.target.defending,false);
  const different=resolveAction({actor:attacker,target:qiGuard.actor,action:{type:'attack',move:'slash'}});
  assert.equal(different.target.hp,92);
  const noQi=createFighter({id:'a',qi:0,poison:1});
  const rejected=resolveAction({actor:noQi,target:attacker,action:{type:'defend',move:'guard_qi'}});
  assert.equal(rejected.ok,false);assert.equal(rejected.actor.hp,100);assert.equal(rejected.actor.poison,1);
  const attackGuard=resolveAction({actor:defender,target:attacker,action:{type:'defend',move:'guard_technique'}});
  assert.equal(attackGuard.actor.qi,30);
  assert.equal(resolveAction({actor:attacker,target:attackGuard.actor,action:{type:'attack'}}).target.hp,95);
  const defaultGuard=resolveAction({actor:defender,target:attacker,action:{type:'defend'}});
  assert.equal(defaultGuard.move,'guard_technique');
  assert.equal(resolveAction({actor:attacker,target:defaultGuard.actor,action:{type:'skill'}}).target.hp,86);
  const miss=resolveAction({actor:attacker,target:attackGuard.actor,action:{type:'attack',move:'heavy_slash'},rng:()=>1});
  assert.equal(miss.target.defending,true);
});
test('interrupted absorption injures meridians and medicine restores them', () => {
  const actor = createFighter({id:'a', cultivation:30});
  const hit = resolveChannel({actor,kind:'absorb',interrupted:true,amount:50});
  assert.equal(hit.actor.meridianDamage,20);
  assert.equal(hit.actor.qi,80);
  assert.equal(hit.actor.cultivation,30);
  const restored = resolveChannel({actor:hit.actor,kind:'medicine'});
  assert.equal(restored.actor.meridianDamage,0);
  assert.equal(restored.actor.qi,100);
});
test('corpse qi halves then decays to zero', () => {
  assert.equal(computeCorpseQi(100,1000,1000),50);
  assert.equal(computeCorpseQi(100,1000,31000),25);
  assert.equal(computeCorpseQi(100,1000,61000),0);
});
test('weighted draw uses damage thresholds and ignores invalid contributions', () => {
  const entries=[{id:'a',damage:70},{id:'b',damage:30},{id:'x',damage:-1}];
  assert.equal(weightedSelect(entries,()=>0.69),'a');
  assert.equal(weightedSelect(entries,()=>0.7),'b');
  assert.equal(weightedSelect([],()=>0),null);
});
test('poison death prevents the action and escape uses injected randomness', () => {
  const actor=createFighter({id:'a',hp:5,poison:1});
  const target=createFighter({id:'b'});
  const killed=resolveAction({actor,target,action:{type:'attack'}});
  assert.equal(killed.actor.dead,true);
  assert.equal(killed.target.hp,100);
  const escaped=resolveAction({actor:createFighter({id:'a'}),target,action:{type:'flee'},rng:()=>0.1});
  assert.equal(escaped.escaped,true);
});
