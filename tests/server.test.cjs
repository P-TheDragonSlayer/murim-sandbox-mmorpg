const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const WebSocket = require('ws');
const { isWalkable } = require('../shared/town-collision.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message='condition') { for(let i=0;i<250;i++){if(predicate())return;await delay(25)} throw new Error(`Timed out: ${message}`); }
async function freePort(){ const server=net.createServer();await new Promise((r,j)=>server.once('error',j).listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port; }
async function startServer(port, dataPath, options={}) {
  const preload=options.realDice?[]:['--require',path.join(__dirname,'fixtures/deterministic-server.cjs')];
  const p=spawn(process.execPath,[...preload,path.join(__dirname,'../server/index.cjs')],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',MURIM_DATA_PATH:dataPath,MURIM_TEST_SHORT_TURNS:options.shortTurns?'1':'0'},stdio:['ignore','pipe','pipe']});
  let output='';p.stdout.on('data',chunk=>output+=chunk);p.stderr.on('data',chunk=>output+=chunk);
  await until(()=>output.includes('Murim prototype')||p.exitCode!==null,'server startup');
  if(p.exitCode!==null)throw Error(output); return p;
}
async function stopServer(p){if(!p||p.exitCode!==null)return; const stopped=new Promise(resolve=>p.once('exit',resolve));p.kill();await stopped;}
async function connect(port,name,token) {
  const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`), c={ws,state:null,welcome:null,errors:[],effects:[],ready:[],rolls:[],autoRoll:true};
  ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='state')c.state=m;if(m.type==='welcome')c.welcome=m;if(m.type==='error')c.errors.push(m.message);if(m.type==='battle_fx')c.effects.push(m);if(m.type==='dice_result')c.rolls.push(m);if(m.type==='roll_ready'){c.ready.push(m);if(c.autoRoll)sendRaw(c,{type:'roll_dice',battleId:m.battleId,rollId:m.rollId})}});
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});send(c,{type:'join',name,token});await until(()=>c.welcome&&c.state,'join');return c;
}
function sendRaw(c,m){c.ws.send(JSON.stringify(m));}
function send(c,m){
  if(m.type==='action' && ['attack','skill','defend'].includes(m.action)) return sendRaw(c,{type:'prepare_roll',action:m.action,...(m.move===undefined?{}:{move:m.move})});
  sendRaw(c,m);
}
test('the unmodified production random source generates two valid d20 values', {timeout:15000}, async()=>{
  const port=await freePort(), dir=fs.mkdtempSync(path.join(os.tmpdir(),'murim-integration-')), dataPath=path.join(dir,'state.json');
  let proc,c;
  try {
    proc=await startServer(port,dataPath,{realDice:true});c=await connect(port,'random dice');
    send(c,{type:'practice'});await until(()=>c.state.battles.length===1,'practice started');
    send(c,{type:'action',action:'attack',move:'slash'});await until(()=>c.rolls.length===1,'real dice result');
    const r=c.rolls[0];assert.equal(r.dice.length,2);assert.ok(r.dice.every(x=>Number.isInteger(x)&&x>=1&&x<=20));
    assert.equal(r.total,r.dice[0]+r.dice[1]);assert.equal(r.success,r.total>=r.target);
  } finally {
    if(c?.ws.readyState===WebSocket.OPEN)c.ws.close();await stopServer(proc);
    if(path.dirname(dir)===os.tmpdir()&&path.basename(dir).startsWith('murim-integration-'))fs.rmSync(dir,{recursive:true,force:true});
  }
});
test('rolls are authoritative, cancellable, single-use and apply permanent death in PvP', {timeout:15000}, async()=>{
  const port=await freePort(), dir=fs.mkdtempSync(path.join(os.tmpdir(),'murim-integration-')), dataPath=path.join(dir,'state.json');
  const fighter=(id,x,hp)=>({id,name:id,x,y:500,hp,maxHp:100,qi:30,qiMax:100,power:10,dead:false,inventory:{potion:2,medicine:1},items:[]});
  fs.writeFileSync(dataPath,JSON.stringify({accounts:{tokenA:fighter('A',500,100),tokenB:fighter('B',524,10)},corpses:[]}));
  let proc,a,b;
  try {
    proc=await startServer(port,dataPath);a=await connect(port,'ignored','tokenA');b=await connect(port,'ignored','tokenB');
    a.autoRoll=false;b.autoRoll=false;
    send(a,{type:'challenge',targetId:'B'});await until(()=>a.state.battles.length===1,'challenge');
    const battleId=a.state.battles[0].id;
    sendRaw(a,{type:'action',action:'attack',move:'slash'});await until(()=>a.errors.length===1,'reject bypass');
    sendRaw(a,{type:'roll_dice',battleId,rollId:'fake',dice:[20,20]});await until(()=>a.errors.length===2,'reject no pending roll');
    send(a,{type:'action',action:'skill',move:'qi_wave'});await until(()=>a.errors.length===3,'reject insufficient qi');
    assert.equal(a.state.players.find(p=>p.id==='A').qi,30);assert.equal(a.state.battles[0].turn,'A');
    send(a,{type:'action',action:'attack',move:'slash'});await until(()=>a.ready.length===1,'ready');
    const old=a.ready[0];assert.equal(old.battleId,battleId);assert.equal(old.target,19);
    assert.equal(a.state.players.find(p=>p.id==='B').hp,10);assert.equal(a.rolls.length,0);assert.equal(a.effects.length,0);
    sendRaw(b,{type:'roll_dice',battleId,rollId:old.rollId});await until(()=>b.errors.length===1,'reject opponent roll');
    sendRaw(a,{type:'cancel_roll',battleId,rollId:old.rollId});await delay(30);
    assert.equal(a.state.battles[0].turn,'A');assert.equal(a.state.players.find(p=>p.id==='A').qi,30);
    send(a,{type:'action',action:'attack',move:'slash'});await until(()=>a.ready.length===2,'second ready');
    const ready=a.ready[1];assert.notEqual(ready.rollId,old.rollId);
    sendRaw(a,{type:'roll_dice',battleId,rollId:old.rollId});await until(()=>a.errors.length===4,'reject stale roll');
    assert.equal(a.rolls.length,0);
    sendRaw(a,{type:'roll_dice',battleId,rollId:ready.rollId,dice:[1,1],success:false,target:40});
    await until(()=>a.rolls.length===1&&b.rolls.length===1,'results delivered');
    assert.deepEqual(a.rolls[0].dice,[20,20]);assert.equal(a.rolls[0].total,40);assert.equal(a.rolls[0].target,19);assert.equal(a.rolls[0].success,true);
    assert.deepEqual(a.rolls[0],b.rolls[0]);
    await until(()=>a.state.corpses.length===1&&!a.state.battles.length,'permadeath applied');
    assert.equal(a.state.players.find(p=>p.id==='B').dead,true);assert.equal(a.state.corpses[0].ownerName,'B');
    sendRaw(a,{type:'roll_dice',battleId,rollId:ready.rollId});await until(()=>a.errors.length===5,'reject replay');
    assert.equal(a.rolls.length,1);
  } finally {
    for(const c of [a,b])if(c?.ws.readyState===WebSocket.OPEN)c.ws.close();await stopServer(proc);
    if(path.dirname(dir)===os.tmpdir()&&path.basename(dir).startsWith('murim-integration-'))fs.rmSync(dir,{recursive:true,force:true});
  }
});
test('a pending roll times out without rolling and clears on session replacement', {timeout:15000}, async()=>{
  const port=await freePort(), dir=fs.mkdtempSync(path.join(os.tmpdir(),'murim-integration-')), dataPath=path.join(dir,'state.json');
  const fighter=(id,x)=>({id,name:id,x,y:500,hp:100,maxHp:100,qi:100,qiMax:100,power:10,dead:false,inventory:{potion:2,medicine:1},items:[]});
  fs.writeFileSync(dataPath,JSON.stringify({accounts:{tokenA:fighter('A',500),tokenB:fighter('B',524)},corpses:[]}));
  let proc,a,b,replacement;
  try {
    proc=await startServer(port,dataPath,{shortTurns:true});a=await connect(port,'ignored','tokenA');b=await connect(port,'ignored','tokenB');a.autoRoll=false;b.autoRoll=false;
    send(a,{type:'challenge',targetId:'B'});await until(()=>a.state.battles.length===1,'challenge');
    send(a,{type:'action',action:'attack',move:'slash'});await until(()=>a.ready.length===1,'pending choice');
    const old=a.ready[0];await until(()=>a.state.battles[0]?.turn==='B','pending timeout');
    assert.equal(a.rolls.length,0);assert.equal(a.effects.length,0);assert.equal(a.state.players.find(p=>p.id==='B').hp,100);
    sendRaw(a,{type:'roll_dice',battleId:old.battleId,rollId:old.rollId});await until(()=>a.errors.length===1,'stale timeout roll');
    send(b,{type:'action',action:'defend',move:'dodge'});await until(()=>b.ready.length===1,'second pending choice');
    const pending=b.ready[0];replacement=await connect(port,'ignored','tokenB');
    await until(()=>a.state.battles.length===0,'reconnect ended battle');
    sendRaw(replacement,{type:'roll_dice',battleId:pending.battleId,rollId:pending.rollId});
    await until(()=>replacement.errors.length===1,'stale reconnect roll');
    assert.equal(replacement.rolls.length,0);assert.equal(replacement.state.players.find(p=>p.id==='B').dead,false);
  } finally {
    for(const c of [a,b,replacement])if(c?.ws.readyState===WebSocket.OPEN)c.ws.close();await stopServer(proc);
    if(path.dirname(dir)===os.tmpdir()&&path.basename(dir).startsWith('murim-integration-'))fs.rmSync(dir,{recursive:true,force:true});
  }
});
test('move catalog and server validate selected moves without consuming a turn', {timeout:15000}, async()=>{
  const port=await freePort(), dir=fs.mkdtempSync(path.join(os.tmpdir(),'murim-integration-')), dataPath=path.join(dir,'state.json');
  fs.writeFileSync(dataPath,JSON.stringify({accounts:{tokenA:{id:'A',name:'A',x:450,y:500,hp:100,maxHp:100,qi:5,qiMax:100,power:10,dead:false,inventory:{potion:2,medicine:1},items:[]}},corpses:[]}));
  let proc,a;
  try {
    proc=await startServer(port,dataPath);
    const response=await fetch(`http://127.0.0.1:${port}/shared/combat-moves.json`);
    assert.equal(response.status,200);assert.equal((await response.json()).guard_qi.cost,10);
    assert.equal((await fetch(`http://127.0.0.1:${port}/shared/rules.cjs`)).status,404);
    a=await connect(port,'ignored','tokenA');send(a,{type:'practice'});
    await until(()=>a.state.battles.length===1,'practice begins');
    send(a,{type:'action',action:'defend',move:'guard_qi'});await until(()=>a.errors.length===1,'reject guard without qi');
    assert.equal(a.state.battles[0].turn,'A');assert.equal(a.state.players.find(p=>p.id==='A').qi,5);
    send(a,{type:'action',action:'attack',move:'qi_wave'});await until(()=>a.errors.length===2,'reject wrong category');
    send(a,{type:'action',action:'attack',move:{toString:null,valueOf:null}});await until(()=>a.errors.length===3,'reject non-string move');
    assert.equal(a.errors[2],'กระบวนท่าไม่ถูกต้อง');
    assert.equal(a.state.battles[0].turn,'A');assert.equal(a.effects.length,0);
    send(a,{type:'action',action:'attack',move:'slash'});await until(()=>a.effects.length===1,'accepted move effect');
    assert.equal(a.effects[0].move,'slash');
    await until(()=>a.state.players.find(p=>p.isDummy)?.hp===90,'dummy damaged');
  } finally {
    if(a?.ws.readyState===WebSocket.OPEN)a.ws.close();await stopServer(proc);
    if(path.dirname(dir)===os.tmpdir()&&path.basename(dir).startsWith('murim-integration-'))fs.rmSync(dir,{recursive:true,force:true});
  }
});
test('shared world positions, gate transitions, combat isolation and safe reconnect', {timeout:15000}, async()=>{
  const port=await freePort(), dir=fs.mkdtempSync(path.join(os.tmpdir(),'murim-integration-')), dataPath=path.join(dir,'state.json');
  const fighter=(id)=>({id,name:id,x:1180,y:300,hp:100,maxHp:100,qi:100,qiMax:100,power:10,dead:false,inventory:{potion:2,medicine:1},items:[]});
  fs.writeFileSync(dataPath,JSON.stringify({accounts:{tokenA:fighter('A'),tokenB:fighter('B')},corpses:[]}));
  let proc,a,b,reconnected;
  try {
    proc=await startServer(port,dataPath);a=await connect(port,'ignored','tokenA');b=await connect(port,'ignored','tokenB');
    assert.deepEqual(a.state.townGate,{x:1280,y:250});assert.deepEqual(a.state.worldTown,{x:550,y:420,radius:70});
    send(a,{type:'move',dx:1,dy:0});send(b,{type:'move',dx:1,dy:0});
    await until(()=>a.state.players.find(p=>p.id==='A')?.location==='world'&&a.state.players.find(p=>p.id==='B')?.location==='world','both enter world');
    assert.equal(a.state.players.find(p=>p.id==='A').mapX,550);
    await delay(100);
    for(let i=0;i<6;i++){send(a,{type:'move',dx:-1,dy:0});await delay(100)}
    await until(()=>b.state.players.find(p=>p.id==='A')?.mapX===454,'other player sees movement');
    send(a,{type:'enter_town'});await until(()=>a.errors.length===1,'reject remote town entry');
    send(a,{type:'challenge',targetId:'B'});await until(()=>a.errors.length===2,'reject world combat');
    send(a,{type:'practice'});await until(()=>a.errors.length===3,'reject world practice');
    assert.equal(a.state.battles.length,0);
    for(let i=0;i<6;i++){send(a,{type:'move',dx:1,dy:0});await delay(100)}
    await until(()=>a.state.players.find(p=>p.id==='A')?.mapX===550,'return to town marker');
    send(a,{type:'enter_town'});await until(()=>a.state.players.find(p=>p.id==='A')?.location==='town','enter town');
    assert.equal(a.state.players.find(p=>p.id==='A').x,1180);assert.equal(a.state.players.find(p=>p.id==='A').y,320);
    send(a,{type:'move',dx:0,dy:1});await until(()=>a.state.players.find(p=>p.id==='A')?.y===344,'move safely away from gate');
    assert.equal(a.state.players.find(p=>p.id==='A').location,'town');
    send(b,{type:'move',dx:1,dy:0});await until(()=>b.state.players.find(p=>p.id==='B')?.mapX===566,'second player moves');
    const closed=new Promise(resolve=>b.ws.once('close',resolve));b.ws.close();await closed;
    await until(()=>!a.state.players.some(p=>p.id==='B'),'disconnect propagated');
    reconnected=await connect(port,'ignored','tokenB');
    const restored=reconnected.state.players.find(p=>p.id==='B');
    assert.equal(restored.location,'town');assert.equal(restored.x,350);assert.equal(restored.y,500);assert.equal(restored.mapX,566);
  } finally {
    for(const c of [a,b,reconnected])if(c?.ws.readyState===WebSocket.OPEN)c.ws.close();await stopServer(proc);
    if(path.dirname(dir)===os.tmpdir()&&path.basename(dir).startsWith('murim-integration-'))fs.rmSync(dir,{recursive:true,force:true});
  }
});
test('independent, repeatable dummy practice is nonlethal and creates no loot', {timeout:30000}, async()=>{
  const port=await freePort(), dir=fs.mkdtempSync(path.join(os.tmpdir(),'murim-integration-')), dataPath=path.join(dir,'state.json');
  let proc,a,b;
  try {
    proc=await startServer(port,dataPath);a=await connect(port,'Student A');b=await connect(port,'Student B');
    assert.equal(a.state.trainingDummy.name,'หุ่นฝึก');
    send(a,{type:'practice'});send(b,{type:'practice'});
    await until(()=>a.state.players.some(p=>p.isDummy)&&b.state.players.some(p=>p.isDummy),'two independent training sessions');
    const ad=a.state.players.find(p=>p.isDummy),bd=b.state.players.find(p=>p.isDummy);
    assert.notEqual(ad.id,bd.id);assert.equal(ad.hp,100);assert.equal(bd.hp,100);
    const aId=a.state.you, initialPower=a.state.players.find(p=>p.id===aId).power;
    send(a,{type:'action',action:'attack'});
    await until(()=>a.state.players.find(p=>p.id===ad.id)?.hp===90,'dummy receives damage');
    assert.equal(b.state.players.find(p=>p.id===bd.id).hp,100,'other practice is independent');
    await until(()=>a.state.battles.some(x=>x.turn===aId),'dummy automatically returns turn');
    for(let i=0;i<9;i++){
      send(a,{type:'action',action:'attack'});
      if(i<8) {
        await until(()=>a.state.players.find(p=>p.id===ad.id)?.hp===80-i*10,'damage applied');
        await until(()=>a.state.battles.some(x=>x.turn===aId),'next training turn');
      }
    }
    await until(()=>!a.state.players.find(p=>p.isDummy),'practice ends on dummy defeat');
    const trainee=a.state.players.find(p=>p.id===aId);
    assert.equal(trainee.dead,false);assert.equal(trainee.hp,100);assert.equal(trainee.power,initialPower);
    assert.equal(a.state.corpses.length,0,'practice must not drop loot or qi');
    send(a,{type:'practice'});await until(()=>a.state.players.some(p=>p.isDummy),'dummy can be challenged again');
    assert.equal(a.state.players.find(p=>p.isDummy).hp,100);
    const latestId=a.state.players.find(p=>p.isDummy).id;
    send(a,{type:'action',action:'attack'});await until(()=>a.state.players.find(p=>p.id===latestId)?.hp===90,'repeat attack');
    a.ws.close(); await until(()=>b.state.battles.every(x=>!x.players.includes(aId)),'practice cleans up on disconnect');
  } finally {
    for(const c of [a,b])if(c?.ws.readyState===WebSocket.OPEN)c.ws.close();await stopServer(proc);
    if(path.dirname(dir)===os.tmpdir()&&path.basename(dir).startsWith('murim-integration-'))fs.rmSync(dir,{recursive:true,force:true});
  }
});
test('a lethal status tick in practice cannot permanently kill the trainee', {timeout:15000}, async()=>{
  const port=await freePort(), dir=fs.mkdtempSync(path.join(os.tmpdir(),'murim-integration-')), dataPath=path.join(dir,'state.json');
  const original={id:'poisoned-trainee',name:'Trainee',x:350,y:500,hp:1,maxHp:100,qi:100,qiMax:100,power:10,dead:false,poison:1,inventory:{potion:2,medicine:1},items:[]};
  fs.writeFileSync(dataPath,JSON.stringify({accounts:{testtoken:original},corpses:[]}));
  let proc,c;
  try {
    proc=await startServer(port,dataPath);c=await connect(port,'ignored','testtoken');
    send(c,{type:'practice'});await until(()=>c.state.players.some(p=>p.isDummy),'practice started');
    send(c,{type:'action',action:'attack'});await until(()=>!c.state.players.some(p=>p.isDummy),'safe practice ends');
    const p=c.state.players.find(player=>player.id==='poisoned-trainee');
    assert.equal(p.hp,1);assert.equal(p.dead,false);assert.equal(p.deaths,0);assert.equal(c.state.corpses.length,0);
    assert.equal(c.rolls.length,1);assert.equal(c.rolls[0].actionCancelled,true);assert.equal(c.effects.length,0,'poison must not show an attack that never happened');
  } finally {
    if(c?.ws.readyState===WebSocket.OPEN)c.ws.close();await stopServer(proc);
    if(path.dirname(dir)===os.tmpdir()&&path.basename(dir).startsWith('murim-integration-'))fs.rmSync(dir,{recursive:true,force:true});
  }
});
test('authoritative battle, interrupted meditation, death, loot, rebirth and persistence across restart', {timeout:30000}, async()=>{
  const port=await freePort(), dir=fs.mkdtempSync(path.join(os.tmpdir(),'murim-integration-')), dataPath=path.join(dir,'state.json');
  let proc, a, b, restored;
  try {
    proc=await startServer(port,dataPath); a=await connect(port,'A');b=await connect(port,'B');const aid=a.state.you,bid=b.state.you;
    for(let i=0;i<10;i++){send(a,{type:'move',direction:1});send(b,{type:'move',direction:1});await delay(100)}
    await until(()=>a.state.players.find(p=>p.id===aid)?.x>=580&&a.state.players.find(p=>p.id===bid)?.x>=580,'move out of city');
    // Two-dimensional movement is authoritative; diagonal input is rejected.
    assert.equal(a.state.players.find(p=>p.id===aid).y,500);
    send(b,{type:'move',dx:1,dy:1});await delay(110);
    assert.equal(b.state.players.find(p=>p.id===bid).y,500);
    for(let i=0;i<7;i++){send(b,{type:'move',dx:0,dy:-1});await delay(100)}
    await until(()=>a.state.players.find(p=>p.id===bid)?.y===332,'move in depth');
    send(a,{type:'challenge',targetId:bid});await until(()=>a.errors.length===1,'reject distant target');
    assert.equal(a.state.battles.length,0);
    for(let i=0;i<7;i++){send(b,{type:'move',dx:0,dy:1});await delay(100)}
    await until(()=>a.state.players.find(p=>p.id===bid)?.y===500,'return in depth');
    send(b,{type:'meditate'});await until(()=>b.state.players.find(p=>p.id===bid)?.channel==='meditate','meditation');
    send(a,{type:'challenge',targetId:bid});await until(()=>a.state.battles.length===1,'challenge');
    await until(()=>b.state.players.find(p=>p.id===bid)?.meridianDamage===20,'interruption');
    const battleId=a.state.battles[0].id;
    // An invalid out-of-turn action must not produce a visual event.
    send(b,{type:'action',action:'attack'}); await until(()=>b.errors.length>0,'reject out-of-turn attack');
    assert.equal(a.effects.length,0); assert.equal(b.effects.length,0);
    for(let i=0;i<30;i++){
      await until(()=>{const t=a.state.battles.find(x=>x.id===battleId);return !t||t.turn===aid},'attacker turn');
      if(!a.state.battles.length)break;send(a,{type:'action',action:'attack'});
      await until(()=>{const t=a.state.battles.find(x=>x.id===battleId);return !t||t.turn===bid},'defender turn');
      if(!a.state.battles.length)break;send(b,{type:'action',action:'defend'});
    }
    await until(()=>!a.state.battles.length&&a.state.corpses.length===1,'death and corpse');
    await until(()=>b.effects.length===a.effects.length,'effects delivered to both');
    assert.ok(a.effects.length>1); assert.deepEqual(a.effects.map(e=>e.id),b.effects.map(e=>e.id));
    assert.equal(new Set(a.effects.map(e=>e.id)).size,a.effects.length);
    assert.equal(a.effects.at(-1).targetDead,true);
    const effectCount=a.effects.length;
    send(a,{type:'move',dx:0,dy:1});await delay(120);
    assert.equal(a.effects.length,effectCount,'movement snapshots must not replay effects');
    send(a,{type:'move',dx:0,dy:-1});await delay(120);

    const corpse=a.state.corpses[0];assert.equal(corpse.y,500);assert.equal(corpse.ownerName,'B');assert.ok(corpse.items.length);assert.ok(corpse.qi>0);
    await until(()=>b.state.players.find(p=>p.id===bid)?.dead,'victim dead');
    // Same X is not enough to loot a corpse when it is too far away on Y.
    for(let i=0;i<5;i++){send(a,{type:'move',dx:0,dy:-1});await delay(100)}
    await until(()=>a.state.players.find(p=>p.id===aid)?.y===380,'move away from corpse');
    const errorsBefore=a.errors.length;send(a,{type:'loot',corpseId:corpse.id});await until(()=>a.errors.length>errorsBefore,'reject distant loot');
    assert.equal(a.state.corpses[0].looted,false);
    const absorbErrors=a.errors.length;send(a,{type:'absorb',corpseId:corpse.id});await until(()=>a.errors.length>absorbErrors,'reject distant absorption');
    for(let i=0;i<5;i++){send(a,{type:'move',dx:0,dy:1});await delay(100)}
    await until(()=>a.state.players.find(p=>p.id===aid)?.y===500,'return to corpse');
    send(a,{type:'loot',corpseId:corpse.id});await until(()=>a.state.corpses[0].looted,'loot');
    assert.ok(a.state.players.find(p=>p.id===aid).items.length>=2);
    send(a,{type:'absorb',corpseId:corpse.id});await until(()=>a.state.players.find(p=>p.id===aid)?.channel==='absorb','start absorption');
    await until(()=>!a.state.players.find(p=>p.id===aid)?.channel,'completed absorption');
    assert.ok(a.state.players.find(p=>p.id===aid).power > 10);assert.ok(a.state.players.find(p=>p.id===aid).power <= 15);assert.equal(a.state.corpses[0].qi,0);
    const doubleErrors=a.errors.length;send(a,{type:'absorb',corpseId:corpse.id});await until(()=>a.errors.length>doubleErrors,'no double absorption');
    send(b,{type:'respawn'});await until(()=>b.state.you!==bid,'rebirth');assert.equal(b.state.players.find(p=>p.id===b.state.you).deaths,1);
    const token=a.welcome.token;a.ws.close();b.ws.close();await delay(200);await stopServer(proc);proc=null;
    proc=await startServer(port,dataPath);restored=await connect(port,'ignored',token);
    assert.equal(restored.state.you,aid);assert.equal(restored.state.players.find(p=>p.id===aid).x,350);assert.equal(restored.state.players.find(p=>p.id===aid).y,500);
    assert.ok(restored.state.players.find(p=>p.id===aid).items.length>=2);assert.equal(restored.state.corpses[0].looted,true);
    const denied=await fetch(`http://127.0.0.1:${port}/server/data/state.json`);assert.equal(denied.status,404);
    // Encoded separators survive URL normalization until the server decodes them.
    const traversal=await fetch(`http://127.0.0.1:${port}/public/%2e%2e%2fserver%2findex.cjs`);
    assert.equal(traversal.status,404, 'private server files must not be readable via encoded traversal');
  } finally {
    for(const c of [a,b,restored])if(c?.ws.readyState===WebSocket.OPEN)c.ws.close();
    await stopServer(proc);
    if(path.dirname(dir)===os.tmpdir()&&path.basename(dir).startsWith('murim-integration-'))fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('WebSocket closes a client that floods messages', {timeout:15000}, async()=>{
  const port=await freePort(), dir=fs.mkdtempSync(path.join(os.tmpdir(),'murim-integration-')), dataPath=path.join(dir,'state.json');
  let proc,c;
  try {
    proc=await startServer(port,dataPath);c=await connect(port,'rate limit');
    const closed=new Promise(resolve=>c.ws.once('close',code=>resolve(code)));
    for(let i=0;i<151;i++)send(c,{type:'unknown'});
    assert.equal(await closed,1008);
  } finally {
    if(c?.ws.readyState===WebSocket.OPEN)c.ws.close();await stopServer(proc);
    if(path.dirname(dir)===os.tmpdir()&&path.basename(dir).startsWith('murim-integration-'))fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('replacing a live session ends its battle for both players', {timeout:15000}, async()=>{
  const port=await freePort(), dir=fs.mkdtempSync(path.join(os.tmpdir(),'murim-integration-')), dataPath=path.join(dir,'state.json');
  let proc,a,b,replacement;
  try {
    proc=await startServer(port,dataPath);a=await connect(port,'A');b=await connect(port,'B');
    for(let i=0;i<10;i++){send(a,{type:'move',direction:1});send(b,{type:'move',direction:1});await delay(100)}
    await until(()=>a.state.players.find(p=>p.id===a.state.you)?.x>=580,'leave safe area');
    send(a,{type:'challenge',targetId:b.state.you});await until(()=>a.state.battles.length===1,'battle started');
    replacement=await connect(port,'ignored',a.welcome.token);
    await until(()=>b.state.battles.length===0,'battle cleared');
    assert.equal(replacement.state.players.find(p=>p.id===replacement.state.you).city,true);
    assert.equal(b.state.players.find(p=>p.id===b.state.you).combatId,null);
  } finally {
    for(const c of [a,b,replacement])if(c?.ws.readyState===WebSocket.OPEN)c.ws.close();
    await stopServer(proc);
    if(path.dirname(dir)===os.tmpdir()&&path.basename(dir).startsWith('murim-integration-'))fs.rmSync(dir,{recursive:true,force:true});
  }
});


test('migrates legacy one-dimensional character and corpse coordinates', {timeout:15000}, async()=>{
  const port=await freePort(), dir=fs.mkdtempSync(path.join(os.tmpdir(),'murim-integration-')), dataPath=path.join(dir,'state.json');
  const originalTime=Date.now();
  const legacy={accounts:{legacytoken:{id:'legacy-id',name:'Legacy',x:200,hp:100,maxHp:100,qi:100,qiMax:100,power:10,dead:false,inventory:{potion:2,medicine:1},items:[]}},corpses:[{id:'legacy-corpse',x:200,ownerName:'Old',qiAtDeath:10,createdAt:originalTime,items:[{id:'legacy-item',name:'artifact'}],absorbed:false}]};
  fs.writeFileSync(dataPath,JSON.stringify(legacy));let proc, c;
  try {
    proc=await startServer(port,dataPath);c=await connect(port,'ignored','legacytoken');
    assert.equal(c.state.players.find(p=>p.id==='legacy-id').y,500);assert.equal(isWalkable(c.state.corpses[0].x,c.state.corpses[0].y),true);assert.equal(c.state.corpses[0].ownerName,'Old');assert.equal(c.state.corpses[0].items[0].id,'legacy-item');
    send(c,{type:'move',dx:0,dy:-1});await until(()=>c.state.players.find(p=>p.id==='legacy-id')?.y===476,'legacy move');
    const persisted=JSON.parse(fs.readFileSync(dataPath,'utf8'));assert.equal(persisted.corpses[0].createdAt,originalTime);assert.equal(persisted.corpses[0].items[0].id,'legacy-item');
  } finally {
    if(c?.ws.readyState===WebSocket.OPEN)c.ws.close();await stopServer(proc);
    if(path.dirname(dir)===os.tmpdir()&&path.basename(dir).startsWith('murim-integration-'))fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('server rejects movement into the blocked area and keeps existing position', {timeout:15000}, async()=>{
  const port=await freePort(), dir=fs.mkdtempSync(path.join(os.tmpdir(),'murim-integration-')), dataPath=path.join(dir,'state.json');
  let proc,c;
  try {
    proc=await startServer(port,dataPath); c=await connect(port,'collision');
    for(let i=0;i<5;i++){send(c,{type:'move',dx:0,dy:-1});await delay(100)}
    await until(()=>c.state.players.find(p=>p.id===c.state.you)?.y===380,'reach the wall');
    send(c,{type:'move',dx:0,dy:-1});await delay(200);
    assert.equal(c.state.players.find(p=>p.id===c.state.you).y,380);
    send(c,{type:'move',dx:0,dy:1});await until(()=>c.state.players.find(p=>p.id===c.state.you)?.y===404,'walk away from wall');
  } finally {
    if(c?.ws.readyState===WebSocket.OPEN)c.ws.close();await stopServer(proc);
    if(path.dirname(dir)===os.tmpdir()&&path.basename(dir).startsWith('murim-integration-'))fs.rmSync(dir,{recursive:true,force:true});
  }
});


test('server blocks the visible lantern base but permits going around it', {timeout:15000}, async()=>{
  const port=await freePort(), dir=fs.mkdtempSync(path.join(os.tmpdir(),'murim-integration-')), dataPath=path.join(dir,'state.json');
  fs.writeFileSync(dataPath,JSON.stringify({accounts:{testtoken:{id:'lantern-test',name:'Test',x:976,y:552,hp:100,maxHp:100,qi:100,qiMax:100,power:10,dead:false,inventory:{potion:2,medicine:1},items:[]}},corpses:[]}));
  let proc,c;
  try {
    proc=await startServer(port,dataPath);c=await connect(port,'ignored','testtoken');
    send(c,{type:'move',dx:1,dy:0});await delay(200);assert.equal(c.state.players.find(p=>p.id===c.state.you).x,976);
    for(let i=0;i<2;i++){send(c,{type:'move',dx:0,dy:-1});await delay(110)}
    await until(()=>c.state.players.find(p=>p.id===c.state.you)?.y===504,'move around lantern');
    send(c,{type:'move',dx:1,dy:0});await until(()=>c.state.players.find(p=>p.id===c.state.you)?.x===1000,'walk past lantern');
  } finally {
    if(c?.ws.readyState===WebSocket.OPEN)c.ws.close();await stopServer(proc);
    if(path.dirname(dir)===os.tmpdir()&&path.basename(dir).startsWith('murim-integration-'))fs.rmSync(dir,{recursive:true,force:true});
  }
});
