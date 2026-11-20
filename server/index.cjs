const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { createFighter, resolveAction, resolveChannel, computeCorpseQi } = require('../shared/rules.cjs');
const { SPAWNS, isWalkable, canTraverse, nearestWalkable } = require('../shared/town-collision.cjs');

// Prototype only: bearer tokens identify players; no production authentication or encryption.
const root = path.resolve(__dirname, '..');
const dataPath = process.env.MURIM_DATA_PATH || path.join(__dirname, 'data', 'state.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const WIDTH = 1600, HEIGHT = 600, LEGACY_Y = 300, TURNS_MS = 30000, CHANNEL_MS = 5000;
const DEFAULT_SPAWN = SPAWNS[1];
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
  if (!player.dead && !isWalkable(player.x, player.y)) Object.assign(player, DEFAULT_SPAWN);
}
// Preserve legacy loot, identity and timestamps while relocating inaccessible corpses.
for (const corpse of state.corpses) {
  if (!isWalkable(corpse.x, corpse.y)) Object.assign(corpse, nearestWalkable(corpse.x, corpse.y));
}
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
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
    dead:p.dead, city:isCity(p.x), inventory:p.id===viewer.id?p.inventory:undefined, combatId:p.combatId||null,
    deaths:p.deaths||0, facing:p.facing||1, meridianDamage:p.meridianDamage||0,
    channel:channels.has(p.id) ? channels.get(p.id).kind : null, items:p.id===viewer.id?p.items:undefined};
}
function visibleCorpses() {
  const now = Date.now();
  return state.corpses.map(c=>({id:c.id,x:c.x,y:c.y,ownerName:c.ownerName,qi:c.absorbed?0:Math.floor(computeCorpseQi(c.qiAtDeath,c.createdAt,now)),items:c.items,looted:!c.items.length}));
}
function broadcast() {
  for (const [playerId, ws] of sockets) {
    const p = Object.values(state.accounts).find(a=>a.id===playerId);
    if (!p) continue;
    send(ws, {type:'state', you:p.id, players:Object.values(state.accounts).filter(a=>sockets.has(a.id) || a.id===p.id).map(a=>publicPlayer(a,p)), battles:[...battles.values()].map(b=>({id:b.id,players:b.players,turn:b.turn,log:b.log})),corpses:visibleCorpses()});
  }
}
function err(ws, message) { send(ws, {type:'error',message}); }
function findPlayer(id) { return Object.values(state.accounts).find(p=>p.id===id); }
function cancelChannel(p, interrupted=true) {
  const channel = channels.get(p.id); if (!channel) return;
  clearTimeout(channel.timer); channels.delete(p.id);
  if (interrupted) Object.assign(p, resolveChannel({actor:p,kind:channel.kind,interrupted:true}).actor);
}
function endBattle(b) {
  if (!b) return;
  clearTimeout(b.timer); battles.delete(b.id);
  for (const playerId of b.players) { const p=findPlayer(playerId); if(p) p.combatId=null; }
}
function sendBattleEffect(b, p, enemy, action, item, result) {
  const effect = {type:'battle_fx',id:id(),battleId:b.id,actorId:p.id,targetId:enemy.id,
    action,item:action==='item'?(item||'potion'):null,escaped:!!result.escaped,
    actorDead:p.hp<=0,targetDead:enemy.hp<=0};
  for (const participant of b.players) {
    const participantSocket=sockets.get(participant);
    if(participantSocket) send(participantSocket,effect);
  }
}
function scheduleTurn(b) {
  clearTimeout(b.timer);
  b.timer=setTimeout(()=>{if(!battles.has(b.id))return; const p=findPlayer(b.turn), enemy=findPlayer(b.players.find(i=>i!==b.turn));
    if(!p||!enemy){endBattle(b);save();broadcast();return;}
    const r=resolveAction({actor:p,target:enemy,action:{type:'defend'}}); Object.assign(p,r.actor); Object.assign(enemy,r.target);
    b.log=`${p.name}: หมดเวลา ป้องกันอัตโนมัติ`; sendBattleEffect(b,p,enemy,'defend',null,r); if(p.hp<=0){kill(p);endBattle(b);}else{b.turn=enemy.id;scheduleTurn(b);} save();broadcast();
  },TURNS_MS);
}
function kill(victim) {
  if(victim.deathHandled) return;
  victim.deathHandled=true; victim.hp=0; victim.dead=true;
  victim.deaths=(victim.deaths||0)+1;
  victim.bestPower=Math.max(victim.bestPower||0,victim.power||0);
  const items=(victim.items||[]).map(item=>({...item,history:[...(item.history||[]),{event:'dropped',owner:victim.name,at:Date.now()}]}));
  for (const [kind,count] of Object.entries(victim.inventory||{})) for(let i=0;i<count;i++)items.push({id:id(),name:kind==='potion'?'ยารักษา':'ยาบำรุง',kind,history:[{event:'dropped',owner:victim.name,at:Date.now()}]});
  state.corpses.push({id:id(),x:victim.x,y:victim.y,ownerName:victim.name,qiAtDeath:(victim.power||0),createdAt:Date.now(),items,absorbed:false});
  victim.items=[]; victim.inventory={potion:0,medicine:0};
}
function processAction(p, b, action, ws, item) {
  if (b.turn!==p.id) return err(ws,'ยังไม่ถึงเทิร์นของคุณ');
  const enemy=findPlayer(b.players.find(i=>i!==p.id)); if(!enemy) return;
  const allowed=['attack','skill','item','defend','flee']; if(!allowed.includes(action)) return err(ws,'คำสั่งไม่ถูกต้อง');
  if(action==='item' && item!==undefined && !['potion','medicine'].includes(item))return err(ws,'ไอเทมไม่ถูกต้อง');
  const r=resolveAction({actor:p,target:enemy,action:{type:action,item:item||'potion'}});
  if(!r.ok) return err(ws, r.log || 'ใช้คำสั่งไม่ได้');
  Object.assign(p,r.actor); Object.assign(enemy,r.target); b.log=String(r.log || '');
  // Presentation events are sent only after an action is accepted. They are not part
  // of snapshots, so movement broadcasts and reconnects cannot replay old effects.
  sendBattleEffect(b,p,enemy,action,item,r);
  for(const participant of b.players){const participantSocket=sockets.get(participant);if(participantSocket)send(participantSocket,{type:'notice',message:b.log});}
  if(enemy.hp<=0) { kill(enemy); endBattle(b); }
  else if(p.hp<=0) { kill(p); endBattle(b); }
  else if(r.escaped) { endBattle(b); const nextX=Math.max(0,p.x-100); if(canTraverse(p.x,p.y,nextX,p.y)) p.x=nextX; }
  else { b.turn=enemy.id; scheduleTurn(b); }
  save(); broadcast();
}
function beginChannel(p, kind, corpseId, ws) {
  if(p.dead || p.combatId || channels.has(p.id)) return err(ws,'กำลังต่อสู้หรือไม่สามารถเริ่มได้');
  let corpse;
  if(kind==='absorb') {
    corpse=state.corpses.find(c=>c.id===corpseId);
    if(!corpse || corpse.absorbed || distance(corpse,p)>100 || computeCorpseQi(corpse.qiAtDeath,corpse.createdAt,Date.now())<=0) return err(ws,'ไม่พบปราณที่ดูดซับได้ในระยะ');
  }
  if(kind==='medicine') {if(!p.inventory?.medicine)return err(ws,'ไม่มียาบำรุง');p.inventory.medicine--;save();}
  const timer=setTimeout(()=>{
    const c=channels.get(p.id); if(!c) return;
    channels.delete(p.id);
    if(corpse && (corpse.absorbed || distance(corpse,p)>100)) { broadcast(); return; }
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
    let token=typeof m.token==='string' && state.accounts[m.token] ? m.token : crypto.randomBytes(32).toString('hex');
    let p=state.accounts[token];
    if(!p) {
      const name=String(m.name||'จอมยุทธ์').trim().slice(0,24)||'จอมยุทธ์';
      p={...createFighter({id:id(),name}),x:DEFAULT_SPAWN.x,y:DEFAULT_SPAWN.y,facing:1,deaths:0,bestPower:0,items:[{id:id(),name:'กระบี่ฝึก',history:[{event:'created',owner:name,at:Date.now()}]}]};
      state.accounts[token]=p; save();
    }
    const old=sockets.get(p.id); sockets.set(p.id,ws); ws.playerId=p.id; if(old && old!==ws)old.close();
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
      const nx=Math.max(0,Math.min(WIDTH,p.x+dx*24));
      const ny=Math.max(0,Math.min(HEIGHT,p.y+dy*24));
      if (!canTraverse(p.x,p.y,nx,ny)) return;
      p.x=nx; p.y=ny;
      if(dx) p.facing=dx;
      save();broadcast(); break;
    }
    case 'challenge': {
      const target=findPlayer(m.targetId);
      if(!target || !sockets.has(target.id) || target.id===p.id || p.dead||target.dead||p.combatId||target.combatId) return err(ws,'ไม่สามารถต่อสู้กับเป้าหมายนี้ได้');
      if(isCity(p.x)||isCity(target.x))return err(ws,'เขตเมืองปลอดภัย ไม่สามารถเริ่มต่อสู้ได้');
      if(distance(target,p)>150)return err(ws,'เป้าหมายอยู่ไกลเกินไป');
      cancelChannel(target);cancelChannel(p);
      const b={id:id(),players:[p.id,target.id],turn:p.id,log:`${p.name} เริ่มโจมตี ${target.name}`};
      p.combatId=b.id;target.combatId=b.id;battles.set(b.id,b);save();scheduleTurn(b);broadcast();break;
    }
    case 'action': {const b=battles.get(p.combatId);if(!b)return err(ws,'ไม่ได้อยู่ในการต่อสู้');processAction(p,b,m.action,ws,m.item);break;}
    case 'meditate': beginChannel(p,'meditate',null,ws);break;
    case 'heal': beginChannel(p,'medicine',null,ws);break;
    case 'absorb':beginChannel(p,'absorb',m.corpseId,ws);break;
    case 'loot': {
      const c=state.corpses.find(c=>c.id===m.corpseId);
      if(p.dead||p.combatId||!c||distance(c,p)>100)return err(ws,'ไม่สามารถเก็บของได้');
      if(!c.items.length)return err(ws,'ไม่มีของให้เก็บ');
      p.items||=[]; for(const item of c.items){if(item.kind==='potion'||item.kind==='medicine')p.inventory[item.kind]=(p.inventory[item.kind]||0)+1;else p.items.push({...item,history:[...(item.history||[]),{event:'looted',owner:p.name,at:Date.now()}]});}c.items=[];save();broadcast();break;
    }
    case 'respawn': {
      if(!p.dead)return err(ws,'ตัวละครยังมีชีวิตอยู่');
      const oldId=p.id, n=createFighter({id:id(),name:p.name});const deaths=p.deaths,bestPower=p.bestPower;
      sockets.delete(oldId);ws.playerId=n.id;sockets.set(n.id,ws);
      Object.assign(p,n,{deathHandled:false,...SPAWNS[crypto.randomInt(SPAWNS.length)],facing:1,deaths,bestPower,combatId:null,items:[{id:id(),name:'กระบี่ฝึก',history:[{event:'created',owner:p.name,at:Date.now()}]}]});
      save();send(ws,{type:'reborn',playerId:p.id});broadcast();break;
    }
  }
}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.svg':'image/svg+xml'};
const server=http.createServer((req,res)=>{
  let url;try{url=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400).end();return;}
  if(url==='/')url='/index.html';
  const allowed=url==='/index.html'||url.startsWith('/src/')||url.startsWith('/assets/')||url.startsWith('/public/')||url.startsWith('/node_modules/phaser/dist/');
  const file=path.resolve(root,'.'+url);if(!allowed||!file.startsWith(root+path.sep)){res.writeHead(404).end();return;}
  fs.readFile(file,(e,data)=>{if(e){res.writeHead(404).end();return;}res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);});
});
const wss=new WebSocketServer({server,path:'/ws',maxPayload:8192});
wss.on('connection', ws=>{
  ws.on('error',()=>{});ws.on('message',raw=>{try{onMessage(ws,raw);}catch(e){console.error('message failure',e);err(ws,'เกิดข้อผิดพลาด');}});
  ws.on('close',()=>{
    const p=findPlayer(ws.playerId);if(!p||sockets.get(p.id)!==ws)return;
    sockets.delete(p.id);cancelChannel(p,false);if(p.combatId)endBattle(battles.get(p.combatId));
    if(!p.dead) Object.assign(p,DEFAULT_SPAWN);save();broadcast();
  });
});
server.listen(PORT,HOST,()=>console.log(`Murim prototype http://${HOST}:${PORT} (prototype token authentication)`));
