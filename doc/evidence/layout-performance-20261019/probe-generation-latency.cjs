#!/usr/bin/env node
// Measure the new viewport immediately after cancellation, without pacing delay.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../..');
const {RasterService}=require(path.join(root,'packages/viewer-builtin/src/layout/raster.cjs'));
const {loadLayoutInputs,verifySources}=require('../layout-p0-20261019/load-layout-inputs.cjs');
const manifest=loadLayoutInputs();
const report={scope:'Immediate newest-generation latency and stale-result cache exclusion',trials:[],status:'running'};
(async()=>{
 for(const fixture of manifest.fixtures){
  const service=new RasterService(process.env.KLAYOUT_PYTHON);const token=`immediate-${fixture.name}`;let generation=0;
  try{
   await service.call({op:'load',path:fixture.path,token});
   for(let trial=0;trial<3;trial++){
    generation++;
    const requests=Array.from({length:8},(_,n)=>({op:'tile',token,generation,layer:fixture.patternedLayerCandidates[(trial+n)%fixture.patternedLayerCandidates.length],box:[fixture.boxes.full[0],fixture.boxes.full[1],fixture.boxes.full[2]-trial*.01,fixture.boxes.full[3]],mode:'auto',pixels:512}));
    const keys=requests.map(request=>service.cacheKey(request));
    const obsolete=requests.map(request=>service.call(request).then(()=>({unexpected:true}),error=>({error:error.message})));
    const cancelStart=performance.now();service.setGeneration(token,++generation);
    const nextBox=fixture.boxes.detail.map((value,index)=>value+(index%2===0?trial*.137:0));
    const nextStart=performance.now();const result=await service.call({op:'tile',token,generation,layer:fixture.patternedLayerCandidates[trial],box:nextBox,mode:'exact',pixels:128});
    const newestMilliseconds=performance.now()-nextStart,values=await Promise.all(obsolete);
    assert.ok(values.every(value=>/superseded/.test(value.error||'')));
    assert.ok(keys.every(key=>!service.cache.has(key)),'Obsolete active/queued results entered cache');
    assert.equal(result.generation,generation);assert.ok(['exact','empty'].includes(result.mode));assert.ok(!result.cacheHit);
    report.trials.push({fixture:fixture.name,trial,newestMilliseconds:Math.round(newestMilliseconds*1000)/1000,totalSinceCancelMilliseconds:Math.round((performance.now()-cancelStart)*1000)/1000,obsoleteRejected:values.length,obsoleteCacheEntries:keys.filter(key=>service.cache.has(key)).length,newestMode:result.mode,workerSelfPeakRssBytes:result.resource.peakRssBytes});
   }
  } finally {service.close();verifySources([fixture]);}
 }
 report.status='passed';
})().catch(error=>{report.status='failed';report.error=error.stack;process.exitCode=1;}).finally(()=>{fs.writeFileSync(path.join(__dirname,'generation-latency.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));});
