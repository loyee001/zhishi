import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { addDays, dateKey, createSeed, applyCare, dueKey, tasksFor, validDate, validatePlant } from '../dist/model.js';

test('calendar arithmetic covers leap days and year rollover', () => {
  assert.equal(addDays('2024-02-28',1),'2024-02-29');
  assert.equal(addDays('2025-02-28',1),'2025-03-01');
  assert.equal(addDays('2026-12-31',1),'2027-01-01');
  assert.equal(validDate('2026-02-30'),false);
});
test('completed watering reschedules from actual completion, leaving fertilizer intact', () => {
  const state = createSeed(new Date(2026,8,28,9));
  const plant = state.plants[0], fertilizer = structuredClone(plant.fertilizer);
  applyCare(state,{plantId:plant.id,type:'water',action:'done',actualDate:'2026-10-01',expected:dueKey(plant.water)},new Date(2026,9,1,16));
  assert.equal(plant.water.lastDate,'2026-10-01');
  assert.equal(plant.water.nextDate,'2026-10-08');
  assert.deepEqual(plant.fertilizer,fertilizer);
  assert.equal(state.history[0].action,'done');
  assert.equal(tasksFor(state,'2026-10-01').some(t => t.plant.id === plant.id && t.type === 'water'),false);
});
test('snoozing future reminders cannot move them earlier; skip does not record a watering', () => {
  const state = createSeed(new Date(2026,9,1,9)), p = state.plants[1], last = p.water.lastDate;
  applyCare(state,{plantId:p.id,type:'water',action:'snooze',minutes:60,expected:dueKey(p.water)},new Date(2026,9,1,10));
  assert.equal(p.water.time,'19:00');
  assert.equal(p.water.lastDate,last);
  applyCare(state,{plantId:p.id,type:'water',action:'skip',expected:dueKey(p.water)},new Date(2026,9,1,10));
  assert.equal(p.water.nextDate,'2026-10-04');
  assert.equal(p.water.lastDate,last);
});
test('overdue items remain visible and disabled plans do not create tasks', () => {
  const s = createSeed(new Date(2026,8,28));
  assert.equal(tasksFor(s,'2026-10-01').length,4);
  s.plants.forEach(p => { p.water.enabled = false; p.fertilizer.enabled = false; });
  assert.equal(tasksFor(s,'2026-10-01').length,0);
});
test('duplicate actions and invalid plant fields are rejected', () => {
  const s = createSeed(), p = s.plants[0];
  const action = {plantId:p.id,type:'water',action:'done',actualDate:dateKey(),expected:dueKey(p.water)};
  applyCare(s,action);
  assert.throws(() => applyCare(s,action),/计划已更新/);
  assert.throws(() => validatePlant({...p,water:{...p.water,intervalDays:0}}),/计划无效/);
  assert.throws(() => validatePlant({...p,image:'javascript:alert(1)'}),/照片/);
});
test('backdated fertilizer uses the entered date and retains watering and reminder time', () => {
  const s = createSeed(new Date(2026,9,1,9)), p = s.plants[2], water = structuredClone(p.water);
  applyCare(s,{plantId:p.id,type:'fertilizer',action:'done',actualDate:'2026-10-03',expected:dueKey(p.fertilizer)},new Date(2026,9,10,18));
  assert.equal(p.fertilizer.lastDate,'2026-10-03');
  assert.equal(p.fertilizer.nextDate,'2026-11-02');
  assert.equal(p.fertilizer.time,'18:00');
  assert.equal(s.history[0].actualDate,'2026-10-03');
  assert.equal(dateKey(s.history[0].at),'2026-10-10');
  assert.deepEqual(p.water,water);
});
test('missing, invalid, future, duplicate, earlier dates and invalid notes never mutate state', () => {
  for (const actualDate of [undefined,'','2026-02-30','2026-10-02','2026-09-01','2026-09-24']) {
    const s = createSeed(new Date(2026,9,1)), p = s.plants[0], before = structuredClone(s);
    assert.throws(() => applyCare(s,{plantId:p.id,type:'water',action:'done',actualDate,expected:dueKey(p.water)},new Date(2026,9,1)),/日期|重复/);
    assert.deepEqual(s,before);
  }
  const s = createSeed(new Date(2026,9,1)), p = s.plants[0], before = structuredClone(s);
  assert.throws(() => applyCare(s,{plantId:p.id,type:'water',action:'done',actualDate:'2026-10-01',expected:dueKey(p.water),note:'x'.repeat(301)},new Date(2026,9,1)),/备注/);
  assert.deepEqual(s,before);
});
test('backdated overdue reminder stays due and a duplicate is rejected even when due key stays the same', () => {
  const s = createSeed(new Date(2026,9,1)), p = s.plants[0];
  p.water.lastDate = null;
  const action = {plantId:p.id,type:'water',action:'done',actualDate:'2026-09-24',expected:dueKey(p.water)};
  applyCare(s,action,new Date(2026,9,10));
  assert.equal(p.water.nextDate,'2026-10-01');
  assert.equal(dueKey(p.water),action.expected);
  assert(tasksFor(s,'2026-10-10').some(t=>t.plant.id===p.id&&t.type==='water'));
  const before = structuredClone(s);
  assert.throws(()=>applyCare(s,action,new Date(2026,9,10)),/重复/);
  assert.deepEqual(s,before);
});
test('entered care date computes through leap day and year rollover', () => {
  for (const [actualDate,intervalDays,expected] of [['2024-02-28',1,'2024-02-29'],['2026-12-30',3,'2027-01-02']]) {
    const s = createSeed(new Date(2027,0,5)), p = s.plants[0];
    p.water.lastDate = null; p.water.intervalDays = intervalDays;
    applyCare(s,{plantId:p.id,type:'water',action:'done',actualDate,expected:dueKey(p.water)},new Date(2027,0,5));
    assert.equal(p.water.nextDate,expected);
  }
});
test('stale confirmation is rejected when interval changes without changing due time', () => {
  const s = createSeed(), p = s.plants[0]; p.revision = 2;
  const before = structuredClone(s);
  assert.throws(()=>applyCare(s,{plantId:p.id,type:'water',action:'done',actualDate:dateKey(),expected:dueKey(p.water),expectedRevision:1}),/计划已修改/);
  assert.deepEqual(s,before);
});
async function start(directory) {
  const child = spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'0',PLANT_DATA_DIR:directory},stdio:['ignore','pipe','pipe']});
  const url = await new Promise((resolve,reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('server startup timeout')),5000);
    child.on('error',reject); child.once('exit',code => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); });
    child.stdout.on('data',chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
  });
  return {url, stop:async () => { const exit = once(child,'exit'); child.kill(); await exit; }};
}
test('API mutations persist after restart and reject stale and cross-origin writes', async () => {
  const directory = await mkdtemp(join(tmpdir(),'zhishi-test-'));
  let server;
  try {
    server = await start(directory);
    const state = await fetch(`${server.url}/api/state`).then(r=>r.json());
    const input = {...state.plants[0],name:'测试植物'};
    let response = await fetch(`${server.url}/api/plants`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    assert.equal(response.status,200);
    let saved = await response.json(); const p = saved.plants.at(-1);
    const care = {plantId:p.id,type:'water',action:'done',actualDate:addDays(dateKey(),-2),expected:dueKey(p.water)};
    const mutate = (payload,origin) => fetch(`${server.url}/api/care`,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(payload)});
    response = await mutate(care,'https://other.example'); assert.equal(response.status,403);
    const missingDate = await mutate({...care,actualDate:undefined}); assert.equal(missingDate.status,400);
    const futureDate = await mutate({...care,actualDate:addDays(dateKey(),1)}); assert.equal(futureDate.status,400);
    const unmodified = await fetch(`${server.url}/api/state`).then(r=>r.json()); assert.equal(unmodified.history.length,0); assert.deepEqual(unmodified.plants.at(-1),p);
    const results = await Promise.all([mutate(care),mutate(care)]); assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    const staleEdit = await fetch(`${server.url}/api/plants/${p.id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...p,name:'旧窗口的修改',revision:0})});
    assert.equal(staleEdit.status,409);
    const invalid = await fetch(`${server.url}/api/plants`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...input,name:''})});
    assert.equal(invalid.status,400);
    await server.stop(); server = await start(directory);
    saved = await fetch(`${server.url}/api/state`).then(r=>r.json());
    assert.equal(saved.plants.length,4); assert.equal(saved.history.length,1);
    assert.equal(saved.plants.at(-1).water.lastDate,care.actualDate);
    assert.equal(saved.plants.at(-1).water.nextDate,addDays(care.actualDate,p.water.intervalDays));
    assert.equal(saved.history[0].actualDate,care.actualDate);
    assert.deepEqual(JSON.parse(await readFile(join(directory,'plants.json'),'utf8')),saved);
    assert.equal((await fetch(`${server.url}/data/plants.json`)).status,404);
    const unicodeBody = Buffer.from(JSON.stringify({...input,name:'薄荷跨块'}));
    const splitAt = unicodeBody.indexOf(Buffer.from('薄')) + 1;
    const unicodeResult = await new Promise((resolve,reject) => {
      const req = request(`${server.url}/api/plants`,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':unicodeBody.length}},res => {
        const chunks = []; res.on('data',c=>chunks.push(c)); res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
      });
      req.on('error',reject); req.write(unicodeBody.subarray(0,splitAt)); setTimeout(()=>req.end(unicodeBody.subarray(splitAt)),20);
    });
    assert.equal(unicodeResult.status,200); assert.equal(unicodeResult.data.plants.at(-1).name,'薄荷跨块');
  } finally { if (server) await server.stop(); await rm(directory,{recursive:true,force:true}); }
});
