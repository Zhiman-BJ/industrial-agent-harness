#!/usr/bin/env node
// Read-only acceptance of existing chip artifacts through the production service.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');
const root = path.resolve(__dirname,'../../..');
const {RasterService} = require(path.join(root,'packages/viewer-builtin/src/layout/raster.cjs'));
const python = process.env.KLAYOUT_PYTHON;
assert.ok(python,'Set KLAYOUT_PYTHON to a KLayout-enabled Python');
const {loadLayoutInputs} = require('./load-layout-inputs.cjs');
const manifest = loadLayoutInputs();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(),'layout-real-p0-'));
const report = {scope:'Existing local chip artifacts, not synthetic stress fixtures',platform:process.platform,started:new Date().toISOString(),scratch:'temporary-oracle-workspace (not published)',fixtures:[],status:'running'};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const payloadHash = value => crypto.createHash('sha256').update(value.positions || value.png || 'empty').digest('hex');
const save = () => fs.writeFileSync(path.join(__dirname,'real-layouts-report.json'),JSON.stringify(report,null,2)+'\n');
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 for(const fixture of manifest.fixtures) {
  const item={name:fixture.name,source:fixture.sourceRef,sha256:hash(fixture.path),stats:fixture.stats,box:fixture.boxes.detail,calls:[],cycles:[],status:'running'};
  report.fixtures.push(item);save();
  const children=new Set();let workersStarted=0,maxLiveWorkers=0;
  const service=new RasterService(python,{rssIntervalMs:100,spawn:(...args)=>{const child=spawn(...args);workersStarted++;children.add(child);maxLiveWorkers=Math.max(maxLiveWorkers,children.size);child.once('exit',()=>children.delete(child));return child;}});
  const token=`p0-${fixture.name}`;let generation=1;
  const job={source:fixture.path,tiles:[],seams:[]};
  async function call(layer,box,mode='exact',pixels=128,label='detail') {
   const request={op:'tile',token,generation,layer,box,mode,pixels};
   const start=performance.now();const result=await service.call(request);
   assert.equal(result.token,token);assert.equal(result.generation,generation);assert.equal(result.layer,layer);assert.deepEqual(result.box,box);
   assert.ok(['exact','empty','overview'].includes(result.mode));
   assert.ok(result.triangleCount<=20000);
   if(result.mode==='exact') assert.equal(Buffer.from(result.positions,'base64').length,result.triangleCount*9*8);
   if(result.mode==='overview') assert.equal(Buffer.from(result.png,'base64').subarray(0,8).toString('hex'),'89504e470d0a1a0a');
   if(!result.cacheHit) assert.ok(result.resource?.peakRssBytes>0&&result.resource.peakRssBytes<=768*1024*1024,'Uncached production result carries real bounded self RSS');
   if(label!=='cycle') item.calls.push({label,layer,mode:result.mode,reason:result.reason,cacheHit:!!result.cacheHit,shapeCount:result.shapeCount,triangleCount:result.triangleCount,milliseconds:Math.round((performance.now()-start)*1000)/1000});
   return result;
  }
  try {
   assert.equal(item.sha256,fixture.sha256);
   const start=performance.now();const metadata=await service.call({op:'load',path:fixture.path,token});
   item.loadMilliseconds=Math.round((performance.now()-start)*1000)/1000;
   assert.equal(metadata.layers.length,fixture.stats.layerCount);assert.equal(metadata.cell,fixture.cell);
   const keys=metadata.layers.map(layer=>layer.key);
   const stableRequests=[];
   for(const key of keys) {
    const result=await call(key,fixture.boxes.full,'overview',128,'whole-overview');assert.equal(result.mode,'overview');
    stableRequests.push({layer:key,box:fixture.boxes.full,mode:'overview',digest:payloadHash(result)});
   }
   for(const key of keys) {
    const detail=await call(key,fixture.boxes.detail);assert.ok(['exact','empty'].includes(detail.mode),'Local ROI must resolve exactly');
    job.tiles.push({case:'detail',response:detail});
    const [l,b,r,t]=fixture.boxes.seam,mid=(l+r)/2;
    const left=await call(key,[l,b,mid,t],'exact',128,'seam-left');const right=await call(key,[mid,b,r,t],'exact',128,'seam-right');
    assert.ok(['exact','empty'].includes(left.mode)&&['exact','empty'].includes(right.mode));
    job.tiles.push({case:'seam-left',response:left},{case:'seam-right',response:right});job.seams.push({layer:key,box:[l,b,r,t],x:mid,left,right});
    if(fixture.patternedLayerCandidates.slice(0,3).includes(key)) stableRequests.push({layer:key,box:fixture.boxes.detail,mode:'exact',digest:payloadHash(detail)});
   }
   const jobFile=path.join(scratch,`${fixture.name}-oracle-input.json`),oracleFile=path.join(__dirname,`${fixture.name}-oracle.json`);
   fs.writeFileSync(jobFile,JSON.stringify(job));
   const oracle=spawnSync(python,[path.join(root,'packages/viewer-builtin/tests/tools/verify-layout-tiles.py'),jobFile,'--output',oracleFile],{encoding:'utf8',timeout:45000,maxBuffer:1024*1024});
   if(fs.existsSync(oracleFile))item.oracle=JSON.parse(fs.readFileSync(oracleFile,'utf8'));
   assert.equal(oracle.status,0,oracle.stderr||oracle.stdout);
   const warmCacheBytes=service.cacheBytes,warmCacheEntries=service.cache.size;
   for(let cycle=0;cycle<12;cycle++) {
    generation++;const start=performance.now();let hits=0;
    for(const request of stableRequests) {const result=await call(request.layer,request.box,request.mode,128,'cycle');assert.equal(result.cacheHit,true);assert.equal(payloadHash(result),request.digest);hits++;}
    assert.equal(service.cacheBytes,warmCacheBytes,'Same key set must not grow cache between generations');assert.equal(service.cache.size,warmCacheEntries);
    item.cycles.push({cycle:cycle+1,generation,requests:stableRequests.length,cacheHits:hits,cacheBytes:service.cacheBytes,cacheEntries:service.cache.size,milliseconds:Math.round((performance.now()-start)*1000)/1000});
   }
   // Kill only this test's own worker during an uncached request; source stays read-only.
   const before=service.worker.child,oldPid=before.pid;
   const exited=new Promise(resolve=>before.once('exit',resolve));
   const pending=service.call({op:'tile',token,generation,layer:keys[0],box:fixture.boxes.detail,mode:'exact',pixels:512}).then(()=>({resolved:true}),error=>({error:error.message}));
   before.kill('SIGKILL');await exited;
   const failure=await pending;assert.ok(failure.error&&/stopped|pipe|killed|changed/i.test(failure.error),JSON.stringify(failure));
   for(let i=0;i<100&&service.active;i++)await pause(10);
   const recovered=await call(keys[0],fixture.boxes.detail,'exact',512,'after-worker-restart');
   assert.ok(!recovered.cacheHit);assert.notEqual(service.worker.child.pid,oldPid);
   const reference=job.tiles.find(entry=>entry.case==='detail'&&entry.response.layer===keys[0]).response;
   assert.equal(payloadHash(recovered),payloadHash(reference),'Reloaded worker returns identical geometry');
   item.recovery={inFlightRejected:failure.error,uncachedRequestSucceeded:true,identicalGeometry:true,workersStarted};
   assert.ok(maxLiveWorkers<=1);assert.ok(service.cacheBytes<=64*1024*1024);
   assert.equal(hash(fixture.path),fixture.sha256);item.sourceUnchanged=true;item.status='passed';
  } catch(error) {item.status='failed';item.error=error.stack;item.sourceUnchanged=hash(fixture.path)===fixture.sha256;}
  finally {item.memoryStats=service.memoryStats;item.maxLiveWorkers=maxLiveWorkers;item.cacheBytes=service.cacheBytes;item.cacheEntries=service.cache.size;service.close();save();console.log(JSON.stringify({name:item.name,status:item.status,oracle:item.oracle,cycles:item.cycles.length,recovery:item.recovery,memory:item.memoryStats,error:item.error?.split('\n')[0]}));}
 }
 report.status=report.fixtures.every(item=>item.status==='passed')?'passed':'failed';report.finished=new Date().toISOString();save();process.exitCode=report.status==='passed'?0:1;
})().catch(error=>{report.status='failed';report.error=error.stack;save();console.error(error);process.exitCode=1;});
