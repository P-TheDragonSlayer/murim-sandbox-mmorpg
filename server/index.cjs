const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { createFighter, validateAction, diceTarget, resolveAction, resolveChannel, computeCorpseQi } = require('../shared/rules.cjs');
const { SPAWNS, isWalkable, canTraverse, nearestWalkable } = require('../shared/town-collision.cjs');

// Prototype only: bearer tokens identify players; no production authentication or encryption.
const root = path.resolve(__dirname, '..');
const dataPath = process.env.MURIM_DATA_PATH || path.join(__dirname, 'data', 'state.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const WIDTH = 1600, HEIGHT = 600, LEGACY_Y = 300, TURNS_MS = 30000, CHANNEL_MS = 5000;
const DEFAULT_SPAWN = SPAWNS[1];
// World map coordinates are normalized to a 1000 x 1000 canvas.
const WORLD_TOWN = Object.freeze({x:550,y:420,radius:70});
const TOWN_GATE = Object.freeze({x:1280,y:250});
const TOWN_GATE_EXIT = Object.freeze({x:1180,y:320});
const inTownGate = (x,y) => x>=1200 && x<=1420 && y>=200 && y<=310;
// Shared landmark; each player gets an independent, non-persistent practice opponent.
const TRAINING_DUMMY = Object.freeze({id:'training-dummy',name:'หุ่นฝึก',x:470,y:500});
const isCity = x => x < 180 || (x >= 300 && x <= 400) || (x >= 600 && x <= 700);
let state = { accounts: {}, corpses: [] };
try { state = JSON.parse(fs.readFileSync(dataPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
state.accounts ||= {}; state.corpses ||= [];
// Existing prototype saves predate 2D coordinates. Keep every legacy entity usable.
for (const entity of [...Object.values(state.accounts), ...state.corpses]) {
  if (!Number.isFinite(entity.y)) entity.y = LEGACY_Y;
}
// Old positions outside the newly authored plaza return to a safe city spawn.
for (const player of Object.values(state.accounts)) {
  if (player.location !== 'world') player.location='town';
  if (!Number.isInteger(player.mapX) || player.mapX<0 || player.mapX>1000) player.mapX=WORLD_TOWN.x;
  if (!Number.isInteger(player.mapY) || player.mapY<0 || player.mapY>1000) player.mapY=WORLD_TOWN.y;
  if (player.location==='town' && !player.dead && !isWalkable(player.x, player.y)) Object.assign(player, DEFAULT_SPAWN);
}
// Preserve legacy loot, identity and timestamps while relocating inaccessible corpses.
for (const corpse of state.corpses) {
  if (corpse.location !== 'world' && !isWalkable(corpse.x, corpse.y)) Object.assign(corpse, nearestWalkable(corpse.x, corpse.y));
}
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const locationOf = p => p.location === 'world' ? 'world' : 'town';
const locationDistance = (a,b) => {
  if(locationOf(a)!==locationOf(b))return Infinity;
  const d=locationOf(a)==='world' ? Math.hypot(a.mapX-b.mapX,a.mapY-b.mapY) : distance(a,b);
  return Number.isFinite(d) ? d : Infinity;
};
const corpseInRange = (c,p) => locationDistance(c,p) <= (locationOf(p)==='world' ? 70 : 100);
const sockets = new Map(), battles = new Map(), channels = new Map();
function save() {
  fs.mkdirSync(path.dirname(dataPath), {recursive: true});
  const tmp = dataPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, dataPath);
}
function id() { return crypto.randomUUID(); }
function send(ws, data) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }
function publicPlayer(p, viewer) {
  return {id:p.id, name:p.name, x:p.x, y:p.y, hp:p.hp, maxHp:p.maxHp, qi:p.id===viewer.id?p.qi:undefined,
    qiMax:p.id===viewer.id?p.qiMax:undefined, power:p.id===viewer.id || viewer.power>=p.power ? p.power : null,
    location:p.location==='world'?'world':'town', mapX:p.mapX, mapY:p.mapY,
    dead:p.dead, city:p.location!=='world' && isCity(p.x), inventory:p.id===viewer.id?p.inventory:undefined, combatId:p.combatId||null,
    deaths:p.deaths||0, facing:p.facing||1, meridianDamage:p.meridianDamage||0,
    channel:channels.has(p.id) ? channels.get(p.id).kind : null, items:p.id===viewer.id?p.items:undefined,
    isDummy:!!p.isDummy};
}
function visibleCorpses() {
  const now = Date.now();
  return state.corpses.map(c=>({id:c.id,x:c.x,y:c.y,location:locationOf(c),mapX:c.mapX,mapY:c.mapY,ownerName:c.ownerName,qi:c.absorbed?0:Math.floor(computeCorpseQi(c.qiAtDeath,c.createdAt,now)),items:c.items,looted:!c.items.length}));
}
function broadcast() {
  for (const [playerId, ws] of sockets) {
    const p = Object.values(state.accounts).find(a=>a.id===playerId);
    if (!p) continue;
    const players=Object.values(state.accounts).filter(a=>sockets.has(a.id) || a.id===p.id).map(a=>publicPlayer(a,p));
    const practice=battles.get(p.combatId);
    if(practice?.dummy) players.push(publicPlayer(practice.dummy,p));
    send(ws, {type:'state', you:p.id, players, townGate:TOWN_GATE, worldTown:WORLD_TOWN, trainingDummy:TRAINING_DUMMY, battles:[...battles.values()].map(b=>({id:b.id,players:b.players,turn:b.turn,log:b.log})),corpses:visibleCorpses()});
  }
}
function err(ws, message) { send(ws, {type:'error',message}); }
function findPlayer(id) { return Object.values(state.accounts).find(p=>p.id===id); }
function findCombatant(b,id) { return b.dummy?.id===id ? b.dummy : findPlayer(id); }
function cancelChannel(p, interrupted=true) {
  const channel = channels.get(p.id); if (!channel) return;
  clearTimeout(channel.timer); channels.delete(p.id);
  if (interrupted) Object.assign(p, resolveChannel({actor:p,kind:channel.kind,interrupted:true}).actor);
}
function endBattle(b) {
  if (!b) return;
  clearTimeout(b.timer); battles.delete(b.id);
  for (const playerId of b.players) { const p=findPlayer(playerId); if(p) {p.combatId=null;p.defending=false;p.defenseType='all';} }
}
function sendBattleEffect(b, p, enemy, action, item, result) {
  const effect = {type:'battle_fx',id:id(),battleId:b.id,actorId:p.id,targetId:enemy.id,
    action,move:result.move||null,hit:result.hit??null,success:result.rollSuccess??null,item:action==='item'?(item||'potion'):null,escaped:!!result.escaped,
    actorDead:p.hp<=0,targetDead:enemy.hp<=0};
  for (const participant of b.players) {
    const participantSocket=sockets.get(participant);
    if(participantSocket) send(participantSocket,effect);
  }
}
function scheduleTurn(b) {
  clearTimeout(b.timer);
  // Practice targets wait rather than damage players; always return the turn.
  if (b.dummy && b.turn===b.dummy.id) {
    b.timer=setTimeout(()=>{
      if(!battles.has(b.id))return;
      const p=findPlayer(b.players[0]);
      if(!p || !sockets.has(p.id)){endBattle(b);broadcast();return;}
      b.turn=p.id; b.log='หุ่นฝึกรอรับการโจมตี'; scheduleTurn(b); broadcast();
    },600);
    return;
  }
  b.timer=setTimeout(()=>{if(!battles.has(b.id))return; const p=findPlayer(b.turn), enemy=findCombatant(b,b.players.find(i=>i!==b.turn));
    if(!p||!enemy){endBattle(b);save();broadcast();return;}
    // A timeout never rolls on the player's behalf. Clear any pending choice,
    // then process poison and consume the turn without granting a defense.
    b.pending=null;
    const r=resolveAction({actor:p,target:enemy,action:{type:'defend'},rollSuccess:false}); Object.assign(p,r.actor); Object.assign(enemy,r.target);
    b.log=`${p.name}: หมดเวลา ข้ามเทิร์น`;
    if(p.hp<=0){if(b.dummy){p.hp=1;p.dead=false;}else kill(p);endBattle(b);}else{b.turn=enemy.id;scheduleTurn(b);} save();broadcast();
  },TURNS_MS);
}
function kill(victim) {
  if(victim.deathHandled) return;
  victim.deathHandled=true; victim.hp=0; victim.dead=true;
  victim.deaths=(victim.deaths||0)+1;
  victim.bestPower=Math.max(victim.bestPower||0,victim.power||0);
  const items=(victim.items||[]).map(item=>({...item,history:[...(item.history||[]),{event:'dropped',owner:victim.name,at:Date.now()}]}));
  for (const [kind,count] of Object.entries(victim.inventory||{})) for(let i=0;i<count;i++)items.push({id:id(),name:kind==='potion'?'ยารักษา':'ยาบำรุง',kind,history:[{event:'dropped',owner:victim.name,at:Date.now()}]});
  state.corpses.push({id:id(),x:victim.x,y:victim.y,location:locationOf(victim),mapX:victim.mapX,mapY:victim.mapY,ownerName:victim.name,qiAtDeath:(victim.power||0),createdAt:Date.now(),items,absorbed:false});
  victim.items=[]; victim.inventory={potion:0,medicine:0};
}
function processAction(p, b, action, ws, item, move, rollSuccess, diceResult) {
  if (b.turn!==p.id) return err(ws,'ยังไม่ถึงเทิร์นของคุณ');
  const enemy=findCombatant(b,b.players.find(i=>i!==p.id)); if(!enemy) return;
  const allowed=['attack','skill','item','defend','flee']; if(!allowed.includes(action)) return err(ws,'คำสั่งไม่ถูกต้อง');
  if(action==='item' && item!==undefined && !['potion','medicine'].includes(item))return err(ws,'ไอเทมไม่ถูกต้อง');
  const r=resolveAction({actor:p,target:enemy,action:{type:action,item:item||'potion',move},rollSuccess});
  if(!r.ok) return err(ws, r.log || 'ใช้คำสั่งไม่ได้');
  if(typeof rollSuccess==='boolean')r.rollSuccess=rollSuccess;
  Object.assign(p,r.actor); Object.assign(enemy,r.target); b.log=String(r.log || '');
  if(diceResult) {
    diceResult.actionCancelled=!!r.actionCancelled;
    for(const participant of b.players){const participantSocket=sockets.get(participant);if(participantSocket)send(participantSocket,diceResult);}
  }
  // Presentation events are sent only after an action is accepted. They are not part
  // of snapshots, so movement broadcasts and reconnects cannot replay old effects.
  if(!r.actionCancelled) sendBattleEffect(b,p,enemy,action,item,r);
  for(const participant of b.players){const participantSocket=sockets.get(participant);if(participantSocket)send(participantSocket,{type:'notice',message:b.log});}
  if(enemy.hp<=0) {
    if(b.dummy) send(ws,{type:'notice',message:'ฝึกสำเร็จ หุ่นฝึกพร้อมใช้อีกครั้ง'});
    else kill(enemy);
    endBattle(b);
  }
  else if(p.hp<=0) {
    if(b.dummy) {p.hp=1;p.dead=false;send(ws,{type:'notice',message:'จบการฝึกอย่างปลอดภัย'});}
    else kill(p);
    endBattle(b);
  }
  else if(r.escaped) { endBattle(b); if(locationOf(p)==='world') p.mapX=Math.max(0,p.mapX-32); else {const nextX=Math.max(0,p.x-100); if(canTraverse(p.x,p.y,nextX,p.y)) p.x=nextX;} }
  else { b.turn=enemy.id; scheduleTurn(b); }
  save(); broadcast();
}
function beginChannel(p, kind, corpseId, ws) {
  if((p.location==='world' && kind!=='absorb') || p.dead || p.combatId || channels.has(p.id)) return err(ws,'ไม่สามารถทำได้ในตำแหน่งนี้');
  let corpse;
  if(kind==='absorb') {
    corpse=state.corpses.find(c=>c.id===corpseId);
    if(!corpse || corpse.absorbed || !corpseInRange(corpse,p) || computeCorpseQi(corpse.qiAtDeath,corpse.createdAt,Date.now())<=0) return err(ws,'ไม่พบปราณที่ดูดซับได้ในระยะ');
  }
  if(kind==='medicine') {if(!p.inventory?.medicine)return err(ws,'ไม่มียาบำรุง');p.inventory.medicine--;save();}
  const timer=setTimeout(()=>{
    const c=channels.get(p.id); if(!c) return;
    channels.delete(p.id);
    if(corpse && (corpse.absorbed || !corpseInRange(corpse,p))) { broadcast(); return; }
    const amount=corpse?computeCorpseQi(corpse.qiAtDeath,corpse.createdAt,Date.now()):undefined;
    if(corpse && amount<=0){broadcast(); return;}
    const result=resolveChannel({actor:p,kind,interrupted:false,amount});
    if(result.ok) {Object.assign(p,result.actor); if(corpse) {corpse.absorbed=true;p.power+=result.absorbed;} else if(kind==='meditate') {const bonus=(p.deaths>0 && p.power<(p.bestPower||0)*0.5) ? 1+0.25*p.deaths : 1;p.power+=bonus;} p.bestPower=Math.max(p.bestPower||0,p.power);save();}
    send(ws,{type:'notice',message:result.log}); broadcast();
  },CHANNEL_MS);
  channels.set(p.id,{kind,timer,corpseId}); broadcast();
}
function onMessage(ws, raw) {
  let m; try {m=JSON.parse(raw.toString());} catch{return err(ws,'ข้อมูลไม่ถูกต้อง');}
  if(!m || typeof m.type!=='string')return;
  if(m.type==='join') {
    if(ws.playerId) return;
    let token=typeof m.token==='string' && Object.hasOwn(state.accounts,m.token) ? m.token : crypto.randomBytes(32).toString('hex');
    let p=state.accounts[token];
    if(!p) {
      const name=String(m.name||'จอมยุทธ์').trim().slice(0,24)||'จอมยุทธ์';
      p={...createFighter({id:id(),name}),x:DEFAULT_SPAWN.x,y:DEFAULT_SPAWN.y,location:'town',mapX:WORLD_TOWN.x,mapY:WORLD_TOWN.y,facing:1,deaths:0,bestPower:0,items:[{id:id(),name:'กระบี่ฝึก',history:[{event:'created',owner:name,at:Date.now()}]}]};
      state.accounts[token]=p; save();
    }
    const old=sockets.get(p.id);
    // A second tab replacing a live session must clean up its battle and
    // channel before taking ownership; the old close handler is intentionally
    // ignored once this socket takes over.
    if(old && old!==ws) {
      cancelChannel(p,false);
      if(p.combatId) endBattle(battles.get(p.combatId));
      if(!p.dead) Object.assign(p,DEFAULT_SPAWN,{location:'town'});
      old.close();
    }
    sockets.set(p.id,ws); ws.playerId=p.id;
    p.combatId=null; send(ws,{type:'welcome',token,playerId:p.id}); broadcast(); return;
  }
  const p=findPlayer(ws.playerId); if(!p || sockets.get(p.id)!==ws) return err(ws,'กรุณาเข้าเกมก่อน');
  switch(m.type) {
    case 'move': {
      if(p.dead || p.combatId || channels.has(p.id))return;
      // One bounded cardinal step per message; legacy horizontal clients remain compatible.
      let dx = m.dx, dy = m.dy;
      if (dx === undefined && dy === undefined) { dx=m.direction; dy=0; }
      if (!Number.isInteger(dx) || !Number.isInteger(dy) || Math.abs(dx)+Math.abs(dy)!==1) return;
      if(Date.now()-(ws.lastMove||0)<80)return; ws.lastMove=Date.now();
      if(p.location==='world') {
        p.mapX=Math.max(0,Math.min(1000,p.mapX+dx*16));
        p.mapY=Math.max(0,Math.min(1000,p.mapY+dy*16));
        save();broadcast();break;
      }
      const nx=Math.max(0,Math.min(WIDTH,p.x+dx*24));
      const ny=Math.max(0,Math.min(HEIGHT,p.y+dy*24));
      if (!canTraverse(p.x,p.y,nx,ny)) return;
      p.x=nx; p.y=ny;
      if(dx) p.facing=dx;
      if(inTownGate(p.x,p.y)) {p.location='world';send(ws,{type:'notice',message:'ออกจากเมืองสู่แผนที่ยุทธภพ'});}
      save();broadcast(); break;
    }
    case 'enter_town': {
      if(p.location!=='world'||p.dead||p.combatId||channels.has(p.id)) return err(ws,'ไม่สามารถเข้าเมืองได้ขณะนี้');
      if(Math.hypot(p.mapX-WORLD_TOWN.x,p.mapY-WORLD_TOWN.y)>WORLD_TOWN.radius) return err(ws,'เข้าใกล้เมืองเริ่มต้นก่อน');
      Object.assign(p,TOWN_GATE_EXIT,{location:'town'});save();send(ws,{type:'notice',message:'เข้าสู่เมืองเริ่มต้น'});broadcast();break;
    }
    case 'challenge': {
      const target=findPlayer(m.targetId);
      if(!target || !sockets.has(target.id) || target.id===p.id || p.dead||target.dead||p.combatId||target.combatId) return err(ws,'ไม่สามารถต่อสู้กับเป้าหมายนี้ได้');
      if(locationOf(p)!==locationOf(target))return err(ws,'ผู้เล่นอยู่คนละพื้นที่');
      if(locationDistance(target,p)>(locationOf(p)==='world'?70:150))return err(ws,'เป้าหมายอยู่ไกลเกินไป');
      cancelChannel(target);cancelChannel(p);
      const b={id:id(),players:[p.id,target.id],turn:p.id,log:`${p.name} เริ่มโจมตี ${target.name}`};
      p.combatId=b.id;target.combatId=b.id;battles.set(b.id,b);save();scheduleTurn(b);broadcast();break;
    }
    case 'practice': {
      if(p.location==='world'||p.dead||p.combatId||channels.has(p.id)) return err(ws,'ไม่สามารถเริ่มฝึกได้ขณะนี้');
      if(distance(p,TRAINING_DUMMY)>150) return err(ws,'เข้าใกล้หุ่นฝึกก่อนเริ่มฝึก');
      const dummy=createFighter({id:'dummy-'+id(),name:TRAINING_DUMMY.name,x:TRAINING_DUMMY.x,y:TRAINING_DUMMY.y,isDummy:true});
      const b={id:id(),players:[p.id,dummy.id],turn:p.id,log:'เริ่มฝึกกับหุ่น: ไม่มีของตกหรือรางวัลปราณ',dummy};
      p.combatId=b.id;battles.set(b.id,b);save();scheduleTurn(b);broadcast();break;
    }
    case 'action': {
      const b=battles.get(p.combatId);if(!b)return err(ws,'ไม่ได้อยู่ในการต่อสู้');
      if(b.pending)return err(ws,'กรุณาทอยหรือยกเลิกก่อน');
      if(['attack','skill','defend'].includes(m.action))return err(ws,'กรุณาเลือกท่าและทอยลูกเต๋า');
      processAction(p,b,m.action,ws,m.item,m.move);break;
    }
    case 'prepare_roll': {
      const b=battles.get(p.combatId);if(!b)return err(ws,'ไม่ได้อยู่ในการต่อสู้');
      if(b.turn!==p.id)return err(ws,'ยังไม่ถึงเทิร์นของคุณ');
      if(b.pending)return err(ws,'กรุณาทอยหรือยกเลิกก่อน');
      if(!['attack','skill','defend'].includes(m.action))return err(ws,'คำสั่งไม่ถูกต้อง');
      const enemy=findCombatant(b,b.players.find(i=>i!==p.id));
      if(!enemy)return err(ws,'ไม่พบคู่ต่อสู้');
      const validation=validateAction({actor:p,target:enemy,action:{type:m.action,move:m.move}});
      if(!validation.ok)return err(ws,validation.log);
      const target=diceTarget(p,enemy,validation.moveId);
      if(target===null)return err(ws,'กระบวนท่าไม่ถูกต้อง');
      b.pending={rollId:id(),actorId:p.id,action:m.action,move:validation.moveId,target};
      send(ws,{type:'roll_ready',battleId:b.id,rollId:b.pending.rollId,action:b.pending.action,move:b.pending.move,target});
      break;
    }
    case 'cancel_roll': {
      const b=battles.get(p.combatId), pending=b?.pending;
      if(!b || b.id!==m.battleId || !pending || pending.rollId!==m.rollId || pending.actorId!==p.id || b.turn!==p.id)return err(ws,'ไม่มีการทอยที่ยกเลิกได้');
      b.pending=null;send(ws,{type:'roll_cancelled',battleId:b.id,rollId:pending.rollId});break;
    }
    case 'roll_dice': {
      const b=battles.get(p.combatId), pending=b?.pending;
      if(!b || b.id!==m.battleId || !pending || pending.rollId!==m.rollId || pending.actorId!==p.id || b.turn!==p.id)return err(ws,'ไม่มีการทอยที่ทำได้');
      const enemy=findCombatant(b,b.players.find(i=>i!==p.id));
      const validation=validateAction({actor:p,target:enemy,action:{type:pending.action,move:pending.move}});
      if(!validation.ok){b.pending=null;return err(ws,validation.log);}
      b.pending=null;
      const dice=[crypto.randomInt(1,21),crypto.randomInt(1,21)], total=dice[0]+dice[1], success=total>=pending.target;
      const result={type:'dice_result',battleId:b.id,rollId:pending.rollId,actorId:p.id,action:pending.action,move:pending.move,dice,total,target:pending.target,success};
      processAction(p,b,pending.action,ws,undefined,pending.move,success,result);break;
    }
    case 'meditate': beginChannel(p,'meditate',null,ws);break;
    case 'heal': beginChannel(p,'medicine',null,ws);break;
    case 'absorb':beginChannel(p,'absorb',m.corpseId,ws);break;
    case 'loot': {
      const c=state.corpses.find(c=>c.id===m.corpseId);
      if(p.dead||p.combatId||!c||!corpseInRange(c,p))return err(ws,'ไม่สามารถเก็บของได้');
      if(!c.items.length)return err(ws,'ไม่มีของให้เก็บ');
      p.items||=[]; for(const item of c.items){if(item.kind==='potion'||item.kind==='medicine')p.inventory[item.kind]=(p.inventory[item.kind]||0)+1;else p.items.push({...item,history:[...(item.history||[]),{event:'looted',owner:p.name,at:Date.now()}]});}c.items=[];save();broadcast();break;
    }
    case 'respawn': {
      if(!p.dead)return err(ws,'ตัวละครยังมีชีวิตอยู่');
      const oldId=p.id, n=createFighter({id:id(),name:p.name});const deaths=p.deaths,bestPower=p.bestPower;
      sockets.delete(oldId);ws.playerId=n.id;sockets.set(n.id,ws);
      Object.assign(p,n,{deathHandled:false,...SPAWNS[crypto.randomInt(SPAWNS.length)],location:'town',facing:1,deaths,bestPower,combatId:null,items:[{id:id(),name:'กระบี่ฝึก',history:[{event:'created',owner:p.name,at:Date.now()}]}]});
      save();send(ws,{type:'reborn',playerId:p.id});broadcast();break;
    }
  }
}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.mp3':'audio/mpeg'};
const server=http.createServer((req,res)=>{
  let url;try{url=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400).end();return;}
  if(url==='/')url='/index.html';
  // Authorize the resolved path, not the encoded URL. An encoded slash can make
  // /public/../server/data resolve to private state after URL decoding.
  if (url.includes('\0')) { res.writeHead(404).end(); return; }
  const file=path.resolve(root,'.'+url);
  const relative=path.relative(root,file).split(path.sep).join('/');
  const allowed=relative==='index.html'||relative==='shared/combat-moves.json'||relative.startsWith('src/')||relative.startsWith('assets/')||relative.startsWith('public/')||relative.startsWith('node_modules/phaser/dist/');
  if(!allowed||!file.startsWith(root+path.sep)){res.writeHead(404).end();return;}
  // Mobile browsers may request only part of an audio file to start or seek.
  if (path.extname(file).toLowerCase()==='.mp3') {
    fs.stat(file,(error,stat)=>{
      if(error||!stat.isFile()){res.writeHead(404).end();return;}
      const headers={'Content-Type':'audio/mpeg','Cache-Control':'no-store','Accept-Ranges':'bytes'};
      const range=req.headers.range;
      let start=0, end=stat.size-1, status=200;
      if(range){
        const match=/^bytes=(\d*)-(\d*)$/.exec(range);
        if(!match || (!match[1] && !match[2])){res.writeHead(416,{...headers,'Content-Range':`bytes */${stat.size}`}).end();return;}
        if(!match[1]){const suffix=Number(match[2]);start=Math.max(0,stat.size-suffix);}
        else {start=Number(match[1]);if(match[2])end=Number(match[2]);}
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=stat.size||end<start){res.writeHead(416,{...headers,'Content-Range':`bytes */${stat.size}`}).end();return;}
        end=Math.min(end,stat.size-1);status=206;headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
      }
      headers['Content-Length']=Math.max(0,end-start+1);
      res.writeHead(status,headers);
      if(req.method==='HEAD'||stat.size===0){res.end();return;}
      const stream=fs.createReadStream(file,{start,end});stream.on('error',()=>res.destroy());stream.pipe(res);
    });
    return;
  }
  fs.readFile(file,(e,data)=>{if(e){res.writeHead(404).end();return;}res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);});
});
const wss=new WebSocketServer({server,path:'/ws',maxPayload:8192});
wss.on('connection', ws=>{
  // A bounded connection and message budget protects this small, single-process
  // prototype against accidental or abusive unbounded broadcasts and disk writes.
  if (wss.clients.size > 128) { ws.close(1013, 'Server full'); return; }
  let windowStarted=Date.now(), windowMessages=0;
  ws.on('error',()=>{});ws.on('message',raw=>{
    const now=Date.now();
    if(now-windowStarted>=10000){windowStarted=now;windowMessages=0;}
    if(++windowMessages>150){ws.close(1008,'Rate limit');return;}
    try{onMessage(ws,raw);}catch(e){console.error('message failure',e);err(ws,'เกิดข้อผิดพลาด');}
  });
  ws.on('close',()=>{
    const p=findPlayer(ws.playerId);if(!p||sockets.get(p.id)!==ws)return;
    sockets.delete(p.id);cancelChannel(p,false);if(p.combatId)endBattle(battles.get(p.combatId));
    if(!p.dead) Object.assign(p,DEFAULT_SPAWN,{location:'town'});save();broadcast();
  });
});
server.listen(PORT,HOST,()=>console.log(`Murim prototype http://${HOST}:${PORT} (prototype token authentication)`));
