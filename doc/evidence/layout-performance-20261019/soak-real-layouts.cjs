#!/usr/bin/env node
// Bounded, headless performance/fault experiment using the production service.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const {RasterService} = require(path.join(root, 'packages/viewer-builtin/src/layout/raster.cjs'));
const python = process.env.KLAYOUT_PYTHON;
assert.ok(python, 'KLAYOUT_PYTHON is required');
const {loadLayoutInputs} = require('../layout-p0-20261019/load-layout-inputs.cjs');
const manifest = loadLayoutInputs();
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const digest = result => crypto.createHash('sha256').update(result.positions || result.png || 'empty').digest('hex');
const files = ['raster.cjs', 'layout.py', 'layout_tiles.py', 'geometry.py', 'layout_resources.py'];
const implementation = () => Object.fromEntries(files.map(name => [name, hash(path.join(root, 'packages/viewer-builtin/src/layout', name))]));
const elapsed = () => Math.round((performance.now() - began) * 1000) / 1000;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const began = performance.now();
const report = {
  status: 'running', started: new Date().toISOString(), platform: process.platform,
  protocol: {epochs: 4, epochSeconds: 15, maxColdRequestsPerEpoch: 300, pairSpacingMs: 50,
    hardWallSeconds: 115, workload: 'Deterministic varying 4/8/16/32 um ROI, 256px auto tiles; each cold request followed by an immediate cache replay',
    memoryNote: 'Worker resource.ru_maxrss is per-process peak/high-water RSS, not current residency or proof of a leak. Node parent RSS is current process.memoryUsage().rss.'},
  implementationBefore: implementation(), sources: manifest.fixtures.map(f => ({name:f.name,path:f.sourceRef,sha256:f.sha256,stats:f.stats})),
  requests: [], samples: [], workers: [], epochs: [], faults: [], findings: [],
};
const save = () => fs.writeFileSync(path.join(__dirname, 'soak-report.json'), JSON.stringify(report, null, 2) + '\n');
let token, generation = 0, currentFixture, sourceEpoch = -1, maxQueue = 0, maxCache = 0, maxLive = 0, maxNotSignalled = 0;
const live = new Map();
const service = new RasterService(python, {spawn:(...args) => {
  const child = spawn(...args), record = {pid:child.pid,spawnMs:elapsed(),sourceEpoch};
  live.set(child,record); report.workers.push(record);
  maxLive=Math.max(maxLive,live.size);
  maxNotSignalled=Math.max(maxNotSignalled,[...live.keys()].filter(c=>!c.killed).length);
  child.once('exit',(code,signal)=>{record.exitMs=elapsed();record.code=code;record.signal=signal;live.delete(child);});
  return child;
}});
function sample(label='interval') {
  maxQueue=Math.max(maxQueue,service.queue.length);maxCache=Math.max(maxCache,service.cacheBytes);
  const memory=process.memoryUsage(), worker=service.worker;
  report.samples.push({ms:elapsed(),label,sourceEpoch,workerPid:worker?.child.pid ?? null,
    workerSelfPeakRssBytes:worker?.resource?.peakRssBytes ?? null,queue:service.queue.length,active:Boolean(service.active),
    cacheBytes:service.cacheBytes,cacheEntries:service.cache.size,liveWorkersAwaitingExit:live.size,
    parentCurrentRssBytes:memory.rss,parentHeapUsedBytes:memory.heapUsed,parentExternalBytes:memory.external});
}
const interval=setInterval(()=>sample(),250);
const hardStop=setTimeout(()=>{report.findings.push('Hard wall limit reached');service.close();},report.protocol.hardWallSeconds*1000);
async function timed(request,label) {
  const start=performance.now(), requestSourceEpoch=sourceEpoch;
  try {
    const pending=service.call(request);maxQueue=Math.max(maxQueue,service.queue.length);
    const result=await pending;
    const row={ms:elapsed(),sourceEpoch:requestSourceEpoch,label,op:request.op,milliseconds:Math.round((performance.now()-start)*1000)/1000,
      cacheHit:!!result.cacheHit,mode:result.mode,reason:result.reason,triangles:result.triangleCount,
      workerPid:service.worker?.child.pid,workerSelfPeakRssBytes:!result.cacheHit?result.resource?.peakRssBytes:undefined};
    report.requests.push(row);maxCache=Math.max(maxCache,service.cacheBytes);
    if(request.op==='tile') {assert.equal(result.token,request.token);assert.equal(result.generation,request.generation);assert.equal(result.layer,request.layer);assert.deepEqual(result.box,request.box);assert.ok(result.triangleCount<=20000);}
    return result;
  } catch(error) {
    report.requests.push({ms:elapsed(),sourceEpoch:requestSourceEpoch,label,op:request.op,milliseconds:Math.round((performance.now()-start)*1000)/1000,error:error.message});
    throw error;
  }
}
const tileRequest = (layer,box,mode='auto',pixels=256) => ({op:'tile',token,generation,layer,box,mode,pixels});
async function expected(request,label) {try {return {result:await timed(request,label)};} catch(error) {return {error:error.message};}}
function movingBox(fixture,index) {
  const [l,b,r,t]=fixture.boxes.full, size=[4,8,16,32][index%4];
  const x=l+size/2+(r-l-size)*((index*7919%65521)/65521);
  const y=b+size/2+(t-b-size)*((index*3571%65519)/65519);
  return [x-size/2,y-size/2,x+size/2,y+size/2].map(n=>Math.round(n*1000)/1000);
}
async function loadSource(fixture,epoch) {
  const oldToken=token,oldFixture=currentFixture;
  const old=[];
  if(oldToken) {
    generation++;
    for(let n=0;n<8;n++)old.push(expected(tileRequest(oldFixture.patternedLayerCandidates[0],movingBox(oldFixture,9000+epoch*8+n),'auto',512),'source-switch-obsolete'));
  }
  sourceEpoch=epoch; currentFixture=fixture;token=`soak-${fixture.name}-${epoch}`;generation=1;
  const result=await timed({op:'load',path:fixture.path,token},'source-load');
  assert.equal(result.cell,fixture.cell);assert.equal(service.cacheBytes,0);assert.equal(service.cache.size,0);
  if(old.length) {
    const values=await Promise.all(old);assert.ok(values.every(value=>value.error&&/selection changed/.test(value.error)),JSON.stringify(values));
    const stale=await expected({op:'tile',token:oldToken,generation:100000,layer:oldFixture.patternedLayerCandidates[0],box:oldFixture.boxes.detail,mode:'auto',pixels:128},'old-source-token');
    assert.ok(stale.error&&/selection changed/.test(stale.error));
    report.faults.push({case:'source-switch',ms:elapsed(),rejectedQueuedOrInFlight:values.length,oldTokenRejected:true});
  }
  sample('source-loaded');
}
async function cancelBurst(count,label) {
  generation++;const pending=[];
  for(let n=0;n<count;n++)pending.push(expected(tileRequest(currentFixture.patternedLayerCandidates[n%3],movingBox(currentFixture,13000+sourceEpoch*100+n),'auto',512),label));
  service.setGeneration(token,++generation);
  const results=await Promise.all(pending),superseded=results.filter(r=>/superseded/.test(r.error||'')).length,full=results.filter(r=>/queue is full/.test(r.error||'')).length;
  assert.equal(superseded+full,count,JSON.stringify(results));
  if(count===40) {assert.equal(full,7);assert.equal(superseded,33);}
  report.faults.push({case:label,ms:elapsed(),count,superseded,queueFull:full});
}
async function crashRecovery() {
  generation++;
  const layer=currentFixture.patternedLayerCandidates[0],box=currentFixture.boxes.detail;
  const reference=await timed(tileRequest(layer,box,'exact',128),'fault-reference');
  assert.ok(['exact','empty'].includes(reference.mode));
  const child=service.worker.child,oldPid=child.pid;
  const exit=new Promise(resolve=>child.once('exit',resolve));
  const request=tileRequest(layer,box,'exact',512);
  const pending=expected(request,'forced-worker-crash');child.kill('SIGKILL');await exit;
  const failure=await pending;assert.ok(failure.error&&/stopped|pipe|killed|changed/i.test(failure.error));
  const start=performance.now();const recovered=await timed(request,'worker-recovery');
  assert.equal(recovered.cacheHit,undefined);assert.notEqual(service.worker.child.pid,oldPid);
  assert.equal(digest(recovered),digest(reference));
  report.faults.push({case:'forced-worker-crash',ms:elapsed(),inFlightRejected:failure.error,identicalUncachedGeometry:true,recoveryMilliseconds:Math.round((performance.now()-start)*1000)/1000});
  sample('worker-recovered');
}
function stats(values) {
  const sorted=[...values].sort((a,b)=>a-b);
  if(!sorted.length)return {count:0};
  const q=p=>sorted[Math.max(0,Math.ceil(sorted.length*p)-1)];
  return {count:sorted.length,p50:q(.5),p95:q(.95),max:sorted.at(-1)};
}
(async()=>{
 try {
  for(const source of report.sources)assert.equal(hash(source.path),source.sha256);
  for(let epoch=0;epoch<4;epoch++) {
    const fixture=manifest.fixtures[epoch%manifest.fixtures.length];await loadSource(fixture,epoch);
    if(epoch===0)await cancelBurst(40,'queue-bound-and-cancel');
    const started=performance.now(),deadline=started+15000;let count=0,nextPair=started;
    while(performance.now()<deadline&&count<300) {
      if(service.closed)throw Error('Service was closed by wall deadline');
      generation++;
      const index=epoch*300+count,layer=fixture.patternedLayerCandidates[count%Math.min(8,fixture.patternedLayerCandidates.length)];
      const request=tileRequest(layer,movingBox(fixture,index));
      const cold=await timed(request,'varying-roi-cold');assert.ok(!cold.cacheHit,'Unique ROI unexpectedly hit cache');
      generation++;const warm=await timed({...request,generation},'immediate-warm');assert.equal(warm.cacheHit,true);assert.equal(digest(warm),digest(cold));
      count++;
      if(count%80===0)await cancelBurst(8,'viewport-generation-cancel');
      if(epoch===2&&count===25)await crashRecovery();
      nextPair+=50;await pause(Math.max(0,nextPair-performance.now()));
    }
    report.epochs.push({epoch,fixture:fixture.name,coldRequests:count,milliseconds:Math.round(performance.now()-started),cacheBytes:service.cacheBytes,cacheEntries:service.cache.size,workerPid:service.worker?.child.pid,workerSelfPeakRssBytes:service.worker?.resource?.peakRssBytes});
    sample('epoch-finished');save();console.log(JSON.stringify({epoch,fixture:fixture.name,coldRequests:count,cacheMiB:service.cacheBytes/1048576,workerPeakMiB:service.worker?.resource?.peakRssBytes/1048576}));
  }
  assert.ok(maxQueue<=32);assert.ok(maxCache<=64*1024*1024);
  report.sourceUnchanged=report.sources.every(source=>hash(source.path)===source.sha256);assert.ok(report.sourceUnchanged);
  report.implementationAfter=implementation();assert.deepEqual(report.implementationAfter,report.implementationBefore,'Production code changed during measurement');
  report.status='passed';
 } catch(error) {report.status='failed';report.error=error.stack;}
 finally {
  clearInterval(interval);clearTimeout(hardStop);service.close();
  const deadline=performance.now()+3000;while(live.size&&performance.now()<deadline)await pause(10);
  sample('after-close');
  report.cleanup={liveWorkers:live.size,queue:service.queue.length,cacheBytes:service.cacheBytes,cacheEntries:service.cache.size,closed:service.closed,workerPointer:service.worker===null};
  if(live.size||service.queue.length||service.cacheBytes||service.worker!==null){report.status='failed';report.findings.push('Incomplete cleanup');}
  const successes=report.requests.filter(row=>!row.error);
  report.latencyMilliseconds={coldWorker:stats(successes.filter(row=>row.label==='varying-roi-cold').map(row=>row.milliseconds)),warmCache:stats(successes.filter(row=>row.label==='immediate-warm').map(row=>row.milliseconds)),sourceLoad:stats(successes.filter(row=>row.label==='source-load').map(row=>row.milliseconds)),workerRecovery:stats(successes.filter(row=>row.label==='worker-recovery').map(row=>row.milliseconds))};
  report.modes=Object.fromEntries(['exact','overview','empty'].map(mode=>[mode,successes.filter(row=>row.label==='varying-roi-cold'&&row.mode===mode).length]));
  report.bounds={maxQueue,maxCacheBytes:maxCache,maxLiveWorkersAwaitingExit:maxLive,maxWorkersNotYetSignalled:maxNotSignalled,parentMaxCurrentRssBytes:Math.max(...report.samples.map(s=>s.parentCurrentRssBytes)),workerMaxSelfPeakRssBytes:Math.max(...report.samples.map(s=>s.workerSelfPeakRssBytes||0),...report.requests.map(row=>row.workerSelfPeakRssBytes||0)),configuredQueue:32,configuredCacheBytes:64*1048576,configuredWorkerSoftRssBytes:768*1048576};
  if(maxLive>1)report.findings.push('Source switching briefly overlaps a terminating worker and its replacement; see worker spawn/exit timestamps.');
  report.durationMilliseconds=elapsed();report.finished=new Date().toISOString();save();
  fs.writeFileSync(path.join(__dirname,'summary.json'),JSON.stringify({status:report.status,protocol:report.protocol,durationMilliseconds:report.durationMilliseconds,latencyMilliseconds:report.latencyMilliseconds,modes:report.modes,bounds:report.bounds,epochs:report.epochs,faults:report.faults,cleanup:report.cleanup,sourceUnchanged:report.sourceUnchanged,error:report.error,findings:report.findings},null,2)+'\n');
  console.log(JSON.stringify({status:report.status,latency:report.latencyMilliseconds,bounds:report.bounds,cleanup:report.cleanup,error:report.error}));process.exitCode=report.status==='passed'?0:1;
 }
})();
