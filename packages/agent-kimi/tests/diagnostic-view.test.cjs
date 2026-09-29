const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createDiagnosticLog} = require('../src/diagnostic-log.cjs');
const {DiagnosticReader} = require('../src/diagnostic-reader.cjs');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'harness-log-view-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const project=path.join(root,'project');fs.mkdirSync(project);
  const log=createDiagnosticLog(project,{directory:path.join(root,'logs'),apiKey:'secret-key'});
  const reader=new DiagnosticReader(path.join(root,'logs'));
  const record=(type,payload)=>log.record(type,payload);
  const event=(type,payload)=>record('sdk.event',{type,payload});
  t.after(()=>log.close());
  return {root,project,log,reader,record,event,runId:path.basename(log.file)};
}
test('stream fragments merge once, concurrent results pair by identity, failures retain messages and UTF-8 output', async t=>{
  const f=fixture(t),{event,record,log,project,runId,reader}=f;
  record('run.start',{model:{model:'fixture'}});record('prompt',{text:'Context\n\nUser task: inspect'});
  event('StepBegin',{n:1});
  for(const text of ['I will ','read files.']) {event('ContentPart',{type:'text',text});record('harness.event',{type:'text',text});}
  event('ToolCall',{id:'a',function:{name:'ReadFile',arguments:'{"path":"a.txt"}'}});record('harness.event',{type:'tool',id:'a',name:'ReadFile'});
  event('ToolCall',{id:'b',function:{name:'ReadFile',arguments:'{"path":"b.txt"}'}});
  event('ToolResult',{tool_call_id:'b',return_value:{is_error:true,output:'',message:'File not found'}});
  const output='工具内容🙂\n'.repeat(20000)+'FULL-END';
  event('ToolResult',{tool_call_id:'a',return_value:{is_error:false,output,message:'secret-key'}});record('harness.event',{type:'tool-result',id:'a',output:'truncated'});
  event('StatusUpdate',{context_usage:.1,token_usage:{input_other:10,output:20}});event('StepBegin',{n:2});
  event('ContentPart',{type:'think',think:'Consider the result.'});event('ContentPart',{type:'text',text:'Done.'});record('run.end',{status:'finished'});log.close();
  const timeline=await reader.view(project,{runId});
  assert.equal(timeline.entries.filter(item=>item.kind==='assistant').length,2);assert.equal(timeline.counts.tools,2);
  const assistant=timeline.entries.find(item=>item.kind==='assistant');assert.equal((await reader.detail(project,{runId,id:assistant.id,field:'text'})).text,'I will read files.');
  assert.equal(timeline.entries.at(-2).title,'最终回答');
  const tools=await reader.view(project,{runId,view:'tools'});assert.equal(tools.entries[0].callId,'a');assert.equal(tools.entries[1].status,'error');
  assert.equal((await reader.detail(project,{runId,id:tools.entries[1].id,field:'message'})).text,'File not found');
  let full='',offset=0;do {const part=await reader.detail(project,{runId,id:tools.entries[0].id,field:'output',offset});assert.ok(!part.text.includes('�'));assert.ok(Buffer.byteLength(part.text)<=65536);full+=part.text;offset=part.nextOffset;}while(offset!=null);assert.equal(full,output);
  assert.equal((await reader.detail(project,{runId,id:tools.entries[0].id,field:'message'})).text,'[REDACTED_API_KEY]');
  assert.equal((await reader.view(project,{runId,view:'tools',query:'b.txt'})).total,1);
});
test('growing runs update the same entry; unfinished calls and orphan results stay visible', async t=>{
  const {record,event,reader,project,runId}=fixture(t);record('run.start',{});event('StepBegin',{n:1});event('ContentPart',{type:'text',text:'Hello'});
  const first=await reader.view(project,{runId});const id=first.entries.at(-1).id;
  event('ContentPart',{type:'text',text:' world'});event('ToolCall',{id:'lost',function:{name:'Shell',arguments:'{}'}});
  assert.equal((await reader.detail(project,{runId,id,field:'text'})).text,'Hello world');
  event('ToolResult',{tool_call_id:'orphan',return_value:{output:'value',is_error:false}});record('run.end',{status:'interrupted'});
  const tools=await reader.view(project,{runId,view:'tools'});assert.equal(tools.entries.length,2);assert.equal(tools.entries[0].status,'missing');assert.equal(tools.entries[1].title,'未记录请求的工具结果');assert.equal(tools.entries[1].durationMs,undefined);
});
function snapshot(f, native, overrides={}) {
  const content=native.map(row=>JSON.stringify(row)).join('\n')+'\n';
  const target=path.join(path.dirname(f.log.file),`${f.log.traceId}.after-turn.context.jsonl`);fs.writeFileSync(target,content);
  f.record('kimi.snapshot',{phase:'after-turn',kind:'context',path:target,bytes:Buffer.byteLength(content),sha256:crypto.createHash('sha256').update(content).digest('hex'),...overrides});
  return target;
}
test('native context boundaries exclude future outputs; system and historical messages remain readable', async t=>{
  const f=fixture(t);f.record('run.start',{});f.record('prompt',{text:'new task'});f.event('StepBegin',{n:1});f.event('StepBegin',{n:2});
  snapshot(f,[{role:'_system_prompt',content:'Real instructions'},{role:'user',content:'old task'},{role:'assistant',content:'old answer'},{role:'user',content:'new task'},{role:'_checkpoint',id:4},{role:'assistant',content:'step1',tool_calls:[{id:'a',function:{name:'ReadFile'}}]},{role:'tool',tool_call_id:'a',content:'result1'},{role:'_checkpoint',id:5},{role:'assistant',content:'future answer'}]);
  const page=await f.reader.view(f.project,{runId:f.runId,view:'context'});
  const steps=page.entries.filter(item=>item.stepId);assert.equal(steps.length,2);assert.equal(steps[0].fields.length,4);assert.equal(steps[1].fields.length,6);
  assert.equal((await f.reader.detail(f.project,{runId:f.runId,id:steps[0].id,field:'message-0'})).text,'Real instructions');
  assert.equal((await f.reader.detail(f.project,{runId:f.runId,id:steps[1].id,field:'message-5'})).text,'result1');
  assert.ok(steps[0].note.includes('完整 HTTP 请求未记录'));
  const timeline=await f.reader.view(f.project,{runId:f.runId});assert.equal(timeline.entries[1].contextId,steps[0].id);
});
test('missing, changed or foreign snapshots fail visibly; project boundary and field offsets are validated', async t=>{
  const f=fixture(t);f.record('run.start',{});snapshot(f,[{role:'user',content:'private'}],{path:'/tmp/foreign.context.jsonl'});
  const page=await f.reader.view(f.project,{runId:f.runId,view:'context'});assert.ok(page.entries.at(-1).title.includes('读取失败'));
  const other=path.join(f.root,'other');fs.mkdirSync(other);await assert.rejects(f.reader.view(other,{runId:f.runId}));
  await assert.rejects(f.reader.view(f.project,{runId:'../'+f.runId}));await assert.rejects(f.reader.detail(f.project,{runId:f.runId,id:'nope',field:'text'}));
  await assert.rejects(f.reader.view(f.project,{runId:f.runId,offset:-1}));
});
test('compacted snapshots are shown without inventing per-step contexts', async t=>{
  const f=fixture(t);f.record('run.start',{});f.record('prompt',{text:'task'});f.event('StepBegin',{n:1});f.event('CompactionBegin',{});f.event('CompactionEnd',{});
  snapshot(f,[{role:'user',content:'task'},{role:'_checkpoint',id:1},{role:'assistant',content:'summary'}]);
  const page=await f.reader.view(f.project,{runId:f.runId,view:'context'});assert.equal(page.entries.filter(item=>item.stepId).length,0);assert.ok(page.entries.at(-1).title.includes('会话上下文'));
});

test('snapshot hash mismatch and symlinks never expose replacement content', async t=>{
  const f=fixture(t);f.record('run.start',{});const target=snapshot(f,[{role:'user',content:'safe data'}]);
  fs.writeFileSync(target,'{"role":"user","content":"evil data"}\n');
  let page=await f.reader.view(f.project,{runId:f.runId,view:'context'});
  const failure=page.entries.at(-1);assert.ok(failure.title.includes('读取失败'));
  assert.match((await f.reader.detail(f.project,{runId:f.runId,id:failure.id,field:'error'})).text,/hash/);
  fs.unlinkSync(target);const foreign=path.join(f.root,'foreign');fs.writeFileSync(foreign,'private');fs.symlinkSync(foreign,target);
  // Force a new append-only projection instead of reusing the validated old data.
  f.record('run.end',{status:'finished'});
  page=await f.reader.view(f.project,{runId:f.runId,view:'context'});assert.ok(page.entries.at(-1).title.includes('读取失败'));
});
