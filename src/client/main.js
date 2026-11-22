import Phaser from '/node_modules/phaser/dist/phaser.esm.js';
import { CHARACTER_LAYERS, CHARACTER_ANIMATIONS, WORLD_ART, BATTLE_ART } from './assets.js';
import { playBattleEffect } from './battle-fx.js';
import { createChannelEffect } from './world-fx.js';

const $ = (id) => document.getElementById(id);
const state = { socket: null, snapshot: null, playerId: null, token: localStorage.getItem('murim-token'), name: localStorage.getItem('murim-name') || '', joined: false };
// Change portraits only when the battle target changes; keep a fallback if loading fails.
function setBattlePortrait(side, url) {
  const holder = document.querySelector(`.fighter-${side}`);
  if (!holder || holder.dataset.portrait === (url || '')) return;
  holder.dataset.portrait = url || '';
  holder.classList.remove('has-art');
  holder.querySelector('.fighter-art')?.remove();
  if (!url) return;
  const portrait = new Image(); portrait.alt = ''; portrait.className = 'fighter-art';
  portrait.onload = () => {
    if (holder.dataset.portrait !== url) return;
    holder.appendChild(portrait); holder.classList.add('has-art');
  };
  portrait.src = url;
}
setBattlePortrait('player', BATTLE_ART.player);
setBattlePortrait('opponent', BATTLE_ART.opponent);

const journal = [];
let scene;
let townBackgroundReady = false;
let mapBackgroundReady = false;
let holdBattleForEffect = 0;
let battleChoice = 0;
let previousBattleId = null;
let deathMenuShown = false;
let menuChoice = null;

function setMenuChoice(element) {
  if (menuChoice) menuChoice.classList.remove('menu-selected');
  menuChoice = element || null;
  if (menuChoice) menuChoice.classList.add('menu-selected');
}

function setMenu(open) {
  const overlay = $('menu-overlay');
  if (!overlay) return;
  overlay.hidden = !open;
  $('control-menu')?.setAttribute('aria-expanded', String(open));
  if (open) {
    setMenuChoice($('menu-close'));
    menuChoice?.focus({preventScroll:true});
  } else setMenuChoice(null);
}

function battleButtons() {
  const bag = document.querySelector('#battle-panel .battle-items');
  const scope = bag?.open ? bag : document.querySelector('#battle-panel .battle-bottom');
  if (!scope) return [];
  return Array.from(scope.querySelectorAll('button[data-action]'))
    .filter(button => button.getClientRects().length && !button.disabled);
}
function highlightBattleChoice() {
  const buttons = battleButtons();
  document.querySelectorAll('#battle-panel button[data-action]').forEach(button => button.classList.remove('selected-action'));
  if (!buttons.length) return;
  battleChoice = Math.min(battleChoice, buttons.length - 1);
  buttons[battleChoice].classList.add('selected-action');
}
function selectDirection(dx, dy) {
  if (!$('menu-overlay').hidden) {
    const buttons = Array.from($('menu-overlay').querySelectorAll('button:not(:disabled), summary'))
      .filter(button => button.getClientRects().length);
    if (!buttons.length) return;
    const current = buttons.indexOf(menuChoice);
    const next = current < 0 ? 0 : (current + (dx < 0 || dy < 0 ? -1 : 1) + buttons.length) % buttons.length;
    setMenuChoice(buttons[next]);
    menuChoice.focus({preventScroll:false});
    menuChoice.scrollIntoView({block:'nearest'});
    return;
  }
  if (!$('battle-panel').hidden) {
    const buttons = battleButtons();
    if (!buttons.length) return;
    const step = dx || dy * 2;
    battleChoice = (battleChoice + step + buttons.length) % buttons.length;
    highlightBattleChoice();
    return;
  }
  const me = state.snapshot?.players?.find(p => p.id === state.playerId);
  if (me?.location === 'world' ? !mapBackgroundReady : !townBackgroundReady) { log('ไม่สามารถเดินได้: โหลดภาพฉากไม่สำเร็จ'); return; }
  send({type:'move', dx, dy});
}

function log(message) {
  if (!message || journal[0] === message) return;
  const battleLog = $('battle-log'); if (battleLog) battleLog.textContent = message;
  journal.unshift(message);
  journal.splice(12);
  $('log').replaceChildren(...journal.map((entry) => { const p = document.createElement('p'); p.textContent = entry; return p; }));
}

function send(message) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message));
  else log('ยังไม่เชื่อมต่อกับเซิร์ฟเวอร์');
}

function connect() {
  $('connection').textContent = 'กำลังเชื่อมต่อ';
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.socket = socket;
  socket.addEventListener('open', () => {
    $('connection').textContent = 'เชื่อมต่อแล้ว';
    document.querySelector('#join-form button[type=submit]').disabled = false;
    if (state.name && state.token) send({ type: 'join', name: state.name, token: state.token });
  });
  socket.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'welcome') {
      state.token = msg.token; state.playerId = msg.playerId; state.joined = true;
      localStorage.setItem('murim-token', msg.token); localStorage.setItem('murim-name', state.name);
      $('join').hidden = true; $('game-ui').hidden = false;
      startGame();
      log('เข้าสู่ยุทธภพแล้ว');
    } else if (msg.type === 'battle_fx') {
      const terminal = msg.actorDead || msg.targetDead || msg.escaped;
      if (terminal) holdBattleForEffect += 1;
      let released = false;
      const release = () => {
        if (!terminal || released) return;
        released = true; holdBattleForEffect = Math.max(0, holdBattleForEffect - 1);
        if (state.snapshot) updateInterface();
      };
      if (!playBattleEffect(msg, state.playerId, release)) release();
    } else if (msg.type === 'state') {
      state.snapshot = msg; state.playerId = msg.you || state.playerId;
      updateInterface(); scene?.renderState(msg);
    } else if (msg.type === 'error' || msg.type === 'notice') log(msg.message || 'เกิดข้อผิดพลาด');
  });
  socket.addEventListener('close', () => {
    $('connection').textContent = 'ขาดการเชื่อมต่อ · กำลังลองใหม่';
    document.querySelector('#join-form button[type=submit]').disabled = true;
    log('การเชื่อมต่อขาด กำลังเชื่อมต่อใหม่');
    setTimeout(connect, 2000);
  });
}

function updateInterface() {
  const s = state.snapshot;
  const me = s.players?.find((p) => p.id === state.playerId);
  if (!me) return;
  $('player-name').textContent = me.name;
  if ($('battle-player-name')) $('battle-player-name').textContent = me.name;
  if ($('battle-player-hp')) $('battle-player-hp').textContent = `${Math.max(0, me.hp)} / ${me.maxHp}`;
  if ($('battle-player-qi')) $('battle-player-qi').textContent = `${Math.round(me.qi)} / ${me.qiMax}`;
  $('hp').textContent = `${Math.max(0, me.hp)} / ${me.maxHp}`;
  $('qi').textContent = `${Math.round(me.qi)} / ${me.qiMax}`;
  $('hp-bar').style.width = `${Math.max(0, Math.min(100, 100 * me.hp / (me.maxHp || 1)))}%`;
  $('qi-bar').style.width = `${Math.max(0, Math.min(100, 100 * me.qi / (me.qiMax || 1)))}%`;
  $('power').textContent = String(Math.round(me.power));
  $('deaths').textContent = String(me.deaths ?? 0);
  $('area').textContent = me.location === 'world' ? 'แผนที่ยุทธภพ' : typeof me.city === 'string' ? me.city : me.city ? 'เขตเมืองปลอดภัย' : 'นอกเมือง';
  $('inventory').textContent = `ยา ${me.inventory?.potion ?? 0} · ยาบำรุง ${me.inventory?.medicine ?? 0}${me.meridianDamage ? ` · เส้นปราณเสียหาย ${me.meridianDamage}` : ''}`;
  $('items').replaceChildren(...(me.items || []).map((item) => { const p = document.createElement('p'); const history = (item.history || []).map((h) => `${h.event}: ${h.owner || '—'}`).join(' → '); p.textContent = `${item.name} · ${history}`; return p; }));
  const battle = s.battles?.find((b) => b.id === me.combatId);
  if (battle && battle.id !== previousBattleId) { battleChoice = 0; setMenu(false); }
  if (me.dead && !holdBattleForEffect && !deathMenuShown) { setMenu(true); deathMenuShown = true; }
  if (!me.dead && deathMenuShown) { setMenu(false); deathMenuShown = false; }
  previousBattleId = battle?.id || null;
  $('battle-panel').hidden = (!battle || me.dead) && !holdBattleForEffect;
  if (!battle && holdBattleForEffect) document.querySelectorAll('button[data-action]').forEach((button) => { button.disabled = true; });
  $('world-actions').hidden = !!battle || me.dead;
  $('dead-panel').hidden = !me.dead;
  $('mode').textContent = me.dead ? 'สิ้นชีวิต' : battle ? 'กำลังต่อสู้' : me.location === 'world' ? (nearWorldTown(me, s) ? 'กด A เข้าเมือง' : 'จุดเขียวคือผู้เดินทาง') : 'เดินทาง';
  if (battle) {
    const myTurn = battle.turn === me.id;
    $('turn').textContent = myTurn ? 'ตาของคุณ' : 'รอคู่ต่อสู้';
    const otherId = battle.players.find((id) => id !== me.id);
    const other = s.players.find((p) => p.id === otherId);
    setBattlePortrait('opponent', other?.isDummy ? BATTLE_ART.dummy : BATTLE_ART.opponent);
    $('opponent').textContent = `คู่ต่อสู้: ${other?.name || 'จอมยุทธ์'} · ชีวิต ${other?.hp ?? '?'} / ${other?.maxHp ?? '?'}`;
    document.querySelectorAll('button[data-action]').forEach((button) => { button.disabled = !myTurn; });
    highlightBattleChoice();
    if (typeof battle.log === 'string') log(battle.log);
    else if (Array.isArray(battle.log) && battle.log.length) log(battle.log.at(-1));
  }
}

// The server owns the 1600×600 plane. Map its feet coordinates to the fixed 960×540 scene.
const project = (x, y) => ({ x: x * 0.6, y: y * 0.9 });
const projectMap = (x, y) => ({ x: x * 0.96, y: y * 0.54 });
function nearWorldTown(me, snapshot) {
  const town = snapshot?.worldTown;
  return !!town && me?.location === 'world' && Math.hypot(me.mapX - town.x, me.mapY - town.y) <= town.radius;
}

class WorldScene extends Phaser.Scene {
  constructor() { super('world'); this.characters = new Map(); this.corpses = new Map(); this.previous = new Map(); this.mapPlayers = new Map(); }
  preload() {
    // Complete painted town is a background, not a set of collision objects.
    this.load.image('town-full-scene', '/public/art/backgrounds/murim-town-dusk-concept-v1.png');
    this.load.image('overworld-map', '/public/art/maps/murim-overworld-v1.jpg');
    this.load.image('world-player-v1', WORLD_ART.player);
    this.load.image('world-dummy-v1', WORLD_ART.dummy);
    for (const layer of CHARACTER_LAYERS) if (layer.url) this.load.spritesheet(layer.key, layer.url, { frameWidth: layer.frameWidth, frameHeight: layer.frameHeight });
  }
  create() {
    scene = this;
    // This static picture and the server's walkable area share the same screen coordinates.
    townBackgroundReady = this.textures.exists('town-full-scene');
    if (townBackgroundReady) {
      this.townImage = this.add.image(0, 0, 'town-full-scene').setOrigin(0).setDisplaySize(960, 540).setDepth(-10000);
    } else {
      this.add.rectangle(0, 0, 960, 540, 0x16211b).setOrigin(0).setDepth(-10000);
      this.add.text(480, 270, 'โหลดภาพเมืองไม่สำเร็จ\nไม่สามารถเดินได้ กรุณารีเฟรช', { fontFamily:'sans-serif', fontSize:'28px', color:'#fff3d4', align:'center', backgroundColor:'#16211b', padding:{x:20,y:16} }).setOrigin(0.5).setDepth(99999);
      log('ไม่สามารถโหลดภาพเมืองได้');
    }
    mapBackgroundReady = this.textures.exists('overworld-map');
    if (mapBackgroundReady) this.mapImage = this.add.image(0, 0, 'overworld-map').setOrigin(0).setDisplaySize(960, 540).setDepth(-9999).setVisible(false);
    this.mapMissing = this.add.text(480, 270, 'โหลดแผนที่ไม่สำเร็จ กรุณารีเฟรช', { fontFamily:'sans-serif', fontSize:'28px', color:'#fff3d4', backgroundColor:'#16211b', padding:{x:20,y:16} }).setOrigin(0.5).setDepth(10000).setVisible(false);
    this.townGateCue = this.add.container(0,0,[
      this.add.ellipse(0,0,90,28,0xffdb83,0.16).setStrokeStyle(3,0xffdf92,0.9),
      this.add.text(0,-38,'ทางออกสู่แผนที่', {fontFamily:'sans-serif',fontSize:'15px',color:'#fff5d7',backgroundColor:'#30362d',padding:{x:5,y:3}}).setOrigin(0.5)
    ]).setDepth(9500).setVisible(false);
    this.worldTownCue = this.add.container(0,0,[
      this.add.circle(0,0,18,0xffe8a1,0.12).setStrokeStyle(2,0xfff0b2),
      this.add.text(0,24,'เมือง · กด A', {fontFamily:'sans-serif',fontSize:'15px',color:'#fff8dc',backgroundColor:'#34382e',padding:{x:5,y:3}}).setOrigin(0.5,0)
    ]).setDepth(9000).setVisible(false);
    for (const layer of CHARACTER_LAYERS) if (layer.url && this.textures.exists(layer.key)) {
      for (const [name, spec] of Object.entries(CHARACTER_ANIMATIONS)) {
        this.anims.create({ key: `${layer.key}-${name}`, frames: this.anims.generateFrameNumbers(layer.key, { start: spec.start, end: spec.end }), frameRate: spec.frameRate, repeat: -1 });
      }
    }
    if (state.snapshot) this.renderState(state.snapshot);
  }
  update(_time, delta) {
    for (const item of this.characters.values()) item.channelFx?.update(delta);
  }
  renderState(s) {
    if (!this.cameras?.main) return;
    // Camera remains fixed so the whole painted scene is visible to every player.
    const me = s.players?.find(p => p.id === state.playerId);
    const onMap = me?.location === 'world';
    this.townImage?.setVisible(!onMap);
    this.mapImage?.setVisible(onMap);
    this.mapMissing.setVisible(onMap && !mapBackgroundReady);
    if (s.townGate) { const gate = project(s.townGate.x, s.townGate.y); this.townGateCue.setPosition(gate.x, gate.y); }
    this.townGateCue.setVisible(!onMap && !!s.townGate);
    if (s.worldTown) { const town = projectMap(s.worldTown.x, s.worldTown.y); this.worldTownCue.setPosition(town.x, town.y); }
    this.worldTownCue.setVisible(onMap && !!s.worldTown);
    this.trainingDummy?.setVisible(!onMap);
    for (const item of this.characters.values()) item.container.setVisible(!onMap);
    for (const marker of this.corpses.values()) marker.setVisible(!onMap);
    if (onMap) {
      const travelers = (s.players || []).filter(p => p.location === 'world' && !p.dead && !p.isDummy && Number.isFinite(p.mapX) && Number.isFinite(p.mapY)).sort((a,b) => a.id.localeCompare(b.id));
      const groups = new Map();
      for (const p of travelers) { const key = `${p.mapX},${p.mapY}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(p); }
      const liveMap = new Set();
      for (const group of groups.values()) group.forEach((p, index) => {
        liveMap.add(p.id);
        let item = this.mapPlayers.get(p.id);
        if (!item) {
          const own = p.id === state.playerId;
          const dot = this.add.circle(0,0,own ? 9 : 7,0x35d763).setStrokeStyle(own ? 3 : 2,own ? 0xffe27b : 0xeaffdc);
          const label = this.add.text(0,-16,'',{fontFamily:'sans-serif',fontSize:'13px',color:'#fff',backgroundColor:'#193526',padding:{x:3,y:1}}).setOrigin(0.5,1);
          const container = this.add.container(0,0,[dot,label]).setDepth(9501);
          item = {container,label}; this.mapPlayers.set(p.id,item);
        }
        const pt = projectMap(p.mapX,p.mapY);
        const angle = 2 * Math.PI * index / group.length;
        const offset = group.length > 1 ? Math.min(25, 8 + group.length * 2) : 0;
        item.container.setPosition(Phaser.Math.Clamp(pt.x + Math.cos(angle)*offset,12,948),Phaser.Math.Clamp(pt.y + Math.sin(angle)*offset,20,520)).setVisible(true);
        item.label.setPosition(0, -16 - (group.length > 1 ? index * 18 : 0));
        item.label.setText(p.name + (p.id === state.playerId ? ' · คุณ' : ''));
      });
      for (const [id,item] of this.mapPlayers) if (!liveMap.has(id)) { item.container.destroy(true); this.mapPlayers.delete(id); }
      return;
    }
    for (const item of this.mapPlayers.values()) item.container.setVisible(false);
    if (s.trainingDummy && !this.trainingDummy) {
      const pt=project(s.trainingDummy.x,s.trainingDummy.y);
      const marker=this.textures.exists('world-dummy-v1')
        ? this.add.image(0,0,'world-dummy-v1').setOrigin(0.5,1).setDisplaySize(64,67)
        : this.add.rectangle(0,-25,25,50,0xb59058);
      const label=this.add.text(0,-72,s.trainingDummy.name,{fontFamily:'sans-serif',fontSize:'13px',color:'#fff9e3',backgroundColor:'#263c34'}).setOrigin(0.5);
      this.trainingDummy=this.add.container(pt.x,pt.y,[marker,label]).setDepth(pt.y*10);
    }
    const live = new Set();
    for (const p of s.players || []) {
      if (p.dead || p.isDummy || p.location === 'world') continue;
      live.add(p.id);
      let item = this.characters.get(p.id);
      if (!item) {
        const own = p.id === state.playerId;
        const shadow = this.add.ellipse(0, 0, 38, 10, 0x1e3027, 0.45);
        const placeholder = this.add.rectangle(0, -26, 27, 50, own ? 0xf8edd4 : 0xc6ded7).setStrokeStyle(2, own ? 0xb99b65 : 0x86aba6);
        const portrait = this.textures.exists('world-player-v1') ? this.add.image(0,0,'world-player-v1').setOrigin(0.5,1).setDisplaySize(64,72) : null;
        const name = this.add.text(0, -78, '', { fontFamily:'sans-serif', fontSize:'13px', color:'#fff9e3', backgroundColor:'#263c34' }).setOrigin(0.5);
        const layers = CHARACTER_LAYERS.filter((layer) => layer.url && this.textures.exists(layer.key)).sort((a,b) => a.depth-b.depth).map((layer) => ({ def: layer, sprite: this.add.sprite(0, 0, layer.key).setOrigin(layer.originX, layer.originY).setScale(layer.scale) }));
        if (portrait || layers.some((l) => l.def.key === 'body')) placeholder.setVisible(false);
        if (portrait && layers.some((l) => l.def.key === 'body')) portrait.setVisible(false);
        const container = this.add.container(0,0,[shadow,placeholder,...(portrait ? [portrait] : []),...layers.map(({sprite})=>sprite),name]);
        item = { container, name, layers, portrait }; this.characters.set(p.id,item);
      }
      if (item.channelFx?.kind !== p.channel) {
        item.channelFx?.destroy();
        item.channelFx = p.channel ? createChannelEffect(this, item.container, p.channel) : null;
      }
      const pt=project(p.x,p.y ?? 300), old=this.previous.get(p.id), moving=old && (old.x !== p.x || old.y !== p.y);
      item.container.setPosition(pt.x,pt.y).setDepth(pt.y*10);
      item.name.setText(p.name + (p.id === state.playerId ? ' · คุณ' : ''));
      item.portrait?.setFlipX(p.facing === -1);
      for (const { def, sprite } of item.layers) { sprite.setFlipX(p.facing === -1); const anim=`${def.key}-${moving ? 'walk' : 'idle'}`; if(sprite.anims.currentAnim?.key !== anim) sprite.play(anim,true); }
      this.previous.set(p.id,{x:p.x,y:p.y});
    }
    for (const [id,item] of this.characters) if(!live.has(id)) { item.channelFx?.destroy();item.container.destroy(true);this.characters.delete(id);this.previous.delete(id); }
    const remains=new Set();
    for (const corpse of s.corpses || []) if (!corpse.looted || corpse.qi > 0) {
      remains.add(corpse.id); let marker=this.corpses.get(corpse.id);
      if(!marker) { marker=this.add.rectangle(0,0,30,11,0x856548).setStrokeStyle(1,0xe1c791);this.corpses.set(corpse.id,marker); }
      const pt=project(corpse.x,corpse.y ?? 300);marker.setPosition(pt.x,pt.y).setDepth(pt.y*10);
    }
    for(const [id,marker] of this.corpses) if(!remains.has(id)) {marker.destroy();this.corpses.delete(id);}
  }
}

function startGame() {
  if (!window.murimGame) window.murimGame = new Phaser.Game({ type: Phaser.AUTO, parent: 'game', width: 960, height: 540, backgroundColor: '#202d31', pixelArt: true, scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }, scene: [WorldScene] });
}
$('name').value = state.name;
$('join-form').addEventListener('submit', (event) => { event.preventDefault(); state.name = $('name').value.trim(); if (state.name) send({ type: 'join', name: state.name, ...(state.token ? { token: state.token } : {}) }); });
for (const b of document.querySelectorAll('button[data-action]')) b.addEventListener('click', () => send({ type: 'action', action: b.dataset.action, ...(b.dataset.item ? { item: b.dataset.item } : {}) }));
$('meditate').addEventListener('click', () => send({ type: 'meditate' }));
$('practice').addEventListener('click', () => send({ type: 'practice' }));
$('heal').addEventListener('click', () => send({ type: 'heal' }));
$('respawn').addEventListener('click', () => send({ type: 'respawn' }));
function nearest(collection) {
  const s = state.snapshot, me = s?.players?.find((p) => p.id === state.playerId);
  if (!me) return null;
  const distance = (entry) => Math.hypot(entry.x - me.x, (entry.y ?? 300) - (me.y ?? 300));
  return collection.filter((entry) => entry.id !== me.id && !entry.dead).sort((a, b) => distance(a) - distance(b))[0] || null;
}
$('challenge').addEventListener('click', () => { const target = nearest(state.snapshot?.players || []); if (target) send({ type: 'challenge', targetId: target.id }); else log('ไม่พบผู้เล่นคนอื่น'); });
for (const type of ['loot', 'absorb']) $(type).addEventListener('click', () => { const corpse = nearest((state.snapshot?.corpses || []).filter((c) => type === 'loot' ? !c.looted : c.qi > 0)); if (corpse) send({ type, corpseId: corpse.id }); else log('ไม่พบสิ่งของหรือปราณตกค้าง'); });
$('control-menu').addEventListener('click', () => setMenu($('menu-overlay').hidden));
$('menu-close').addEventListener('click', () => setMenu(false));
$('menu-overlay').addEventListener('focusin', event => {
  if (event.target.matches('button, summary')) setMenuChoice(event.target);
});
$('control-a').addEventListener('click', () => {
  if (!$('menu-overlay').hidden) {
    const selected = menuChoice;
    if (selected && $('menu-overlay').contains(selected) && selected.matches('button, summary')) selected.click();
  } else if (!$('battle-panel').hidden) {
    battleButtons()[battleChoice]?.click();
  } else {
    const me = state.snapshot?.players?.find(p => p.id === state.playerId);
    if (nearWorldTown(me, state.snapshot)) send({type:'enter_town'});
    else setMenu(true);
  }
});
$('control-b').addEventListener('click', () => {
  if (!$('menu-overlay').hidden) return setMenu(false);
  if (!$('battle-panel').hidden) {
    const items = document.querySelector('#battle-panel .battle-items');
    if (items) { items.open = !items.open; battleChoice = 0; highlightBattleChoice(); }
  }
});
document.querySelector('#battle-panel .battle-items')?.addEventListener('toggle', () => highlightBattleChoice());
document.querySelectorAll('#world-actions button').forEach(button => button.addEventListener('click', () => setMenu(false)));
for (const [id, dx, dy] of [['left', -1, 0], ['right', 1, 0], ['up', 0, -1], ['down', 0, 1]]) {
  const button = $(id); let timer;
  const stop = () => { clearInterval(timer); timer = undefined; };
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault(); button.setPointerCapture(event.pointerId);
    if (timer) return;
    selectDirection(dx,dy);
    if ($('menu-overlay').hidden && $('battle-panel').hidden) timer = setInterval(() => {
      if (!$('menu-overlay').hidden || !$('battle-panel').hidden) return stop();
      selectDirection(dx,dy);
    }, 160);
  });
  button.addEventListener('pointerup', stop); button.addEventListener('pointercancel', stop); button.addEventListener('lostpointercapture', stop);
}
window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return;
  const key=event.key.toLowerCase();
  const directions={arrowleft:[-1,0],a:[-1,0],arrowright:[1,0],d:[1,0],arrowup:[0,-1],w:[0,-1],arrowdown:[0,1],s:[0,1]};
  if (directions[key]) { event.preventDefault(); if (event.repeat && (!$('menu-overlay').hidden || !$('battle-panel').hidden)) return; const [dx,dy]=directions[key]; selectDirection(dx,dy); }
  else if (key === 'enter' || key === 'z') { event.preventDefault(); $('control-a').click(); }
  else if (key === 'escape' || key === 'x') { event.preventDefault(); $('control-b').click(); }
});
connect();
