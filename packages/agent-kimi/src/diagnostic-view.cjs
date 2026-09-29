// A read-only projection of diagnostic events. The source log remains unchanged.
const text = value => typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
const preview = value => text(value).replace(/\s+/g, ' ').slice(0, 240);
function projectEvents(records, snapshots = new Map()) {
  const entries = [], contexts = [], calls = new Map(), steps = new Map();
  let step = null, message = null, ended = false, prompt = null, start = null;
  const sdk = records.some(row => row.type === 'sdk.event');
  function add(row, kind, title, fields = []) {
    const entry = {id: `${kind}:${row.sequence}`, kind, title, at: row.at, sequences: [row.sequence], stepId: step?.id ?? null, fields};
    entries.push(entry); return entry;
  }
  const field = (key, label, value, open = true) => ({key, label, text: text(value), open});
  for (const row of records) {
    const event = row.payload ?? {}, p = event.payload ?? {};
    if (row.type === 'run.start') {start = row; contexts.push({...add(row, 'configuration', '运行配置', [field('model', '模型', event.model), field('scope', 'Broker 工具与 Skill 范围', event.scope), field('broker', '能力选择依据', event.brokerTrace, false)]), contextOnly: true}); entries.pop();}
    if (row.type === 'prompt') {
      prompt = row; const content = text(event.text), split = content.lastIndexOf('\n\nUser task: ');
      message = null;
      add(row, 'user', '用户输入', [field('text', '用户消息', split < 0 ? content : content.slice(split + 13))]);
      contexts.push({id: `prompt:${row.sequence}`, kind: 'context', title: '本轮 SDK 输入', at: row.at, sequences: [row.sequence], fields: [field('prompt', '完整送入 SDK 的提示', event.text)]});
    }
    if (row.type === 'context.anchor') contexts.push({id: `anchor:${row.sequence}`, kind: 'context', title: '项目观察与 Checkpoint', at: row.at, sequences: [row.sequence], fields: [field('anchor', '传入的项目观察', event)]});
    if (row.type === 'sdk.event' && event.type === 'StepBegin' || !sdk && row.type === 'harness.event' && event.type === 'step') {
      message = null; step = add(row, 'step', `模型第 ${p.n ?? event.number} 步`); step.stepId = step.id; step.number = p.n ?? event.number; steps.set(step.id, step);
    }
    if (row.type === 'sdk.event' && event.type === 'ContentPart' || !sdk && row.type === 'harness.event' && ['text','thinking'].includes(event.type)) {
      const thinking = row.type === 'sdk.event' ? p.type === 'think' : event.type === 'thinking';
      const content = row.type === 'sdk.event' ? (thinking ? p.think : p.type === 'text' ? p.text : null) : event.text;
      if (typeof content !== 'string') continue;
      if (!message) message = add(row, 'assistant', '模型回复'); else message.sequences.push(row.sequence);
      const key = thinking ? 'thinking' : 'text'; let part = message.fields.find(item => item.key === key);
      if (!part) {part = field(key, thinking ? '模型思考' : '完整回复', '', !thinking); message.fields.push(part);}
      part.text += content;
    }
    if (row.type === 'sdk.event' && event.type === 'ToolCall' || !sdk && row.type === 'harness.event' && event.type === 'tool') {
      message = null; const id = row.type === 'sdk.event' ? p.id : event.id;
      const call = add(row, 'tool', row.type === 'sdk.event' ? p.function?.name || '未知工具' : event.name, [field('input', '调用参数', row.type === 'sdk.event' ? p.function?.arguments : event.arguments)]);
      call.callId = id; call.status = 'running'; calls.set(id, call);
    }
    if (row.type === 'sdk.event' && event.type === 'ToolResult' || !sdk && row.type === 'harness.event' && event.type === 'tool-result') {
      message = null; const id = row.type === 'sdk.event' ? p.tool_call_id : event.id;
      const value = row.type === 'sdk.event' ? p.return_value ?? {} : {output:event.output, message:event.message, is_error:event.error};
      let call = calls.get(id);
      if (!call) {call = add(row, 'tool', '未记录请求的工具结果'); call.callId = id; calls.set(id, call);} else call.sequences.push(row.sequence);
      call.status = value.is_error === true ? 'error' : value.is_error === false ? 'success' : 'unknown';
      const duration = new Date(row.at) - new Date(call.at); if (call.fields.some(item=>item.key==='input') && duration >= 0) call.durationMs = duration;
      call.fields.push(field('output', '返回结果', value.output ?? ''));
      if (value.message) call.fields.push(field('message', '结果说明', value.message));
      if (value.display?.length) call.fields.push(field('display', '补充展示', value.display, false));
    }
    if (row.type === 'sdk.event' && event.type === 'StatusUpdate' && step) {step.usage = p.token_usage; step.contextUsage = p.context_usage; step.sequences.push(row.sequence);}
    if (row.type === 'sdk.event' && ['CompactionBegin','CompactionEnd','ApprovalRequest','ApprovalResponse'].includes(event.type)) {
      message = null; add(row, event.type.startsWith('Compaction') ? 'compaction' : 'approval', {CompactionBegin:'上下文压缩开始',CompactionEnd:'上下文压缩完成',ApprovalRequest:'请求审批',ApprovalResponse:'审批结果'}[event.type], [field('detail','记录内容', p)]);
    }
    if (row.type === 'approval.response') add(row, 'approval', '审批决定', [field('detail', '记录内容', event)]);
    if (row.type === 'turn.interrupt' || row.type === 'harness.event' && event.type === 'error') {message = null; add(row, 'error', row.type === 'turn.interrupt' ? '任务中断' : '运行错误', [field('detail','记录内容',event)]);}
    if (row.type === 'run.end') {
      ended = true; message = null;
      const last = [...entries].reverse().find(item=>['assistant','tool'].includes(item.kind));
      if (['completed','finished'].includes(event.status) && last?.kind === 'assistant' && last.fields.some(item=>item.key==='text')) last.title = '最终回答';
      const end = add(row, 'end', '运行结束', [field('detail', '运行结果', event)]); end.status = event.status;
    }
  }
  for (const entry of entries) {
    if (entry.kind === 'tool' && entry.status === 'running' && ended) entry.status = 'missing';
    entry.summary = preview(entry.fields.find(item=>item.key==='text' || item.key==='input')?.text ?? entry.fields[0]?.text ?? '');
  }
  const lastSnapshot = records.filter(row=>row.type==='kimi.snapshot' && row.payload?.kind==='context' && row.payload.phase==='after-turn').at(-1);
  if (lastSnapshot) {
    const native = snapshots.get(lastSnapshot.sequence);
    if (native?.error) contexts.push({id:`snapshot:${lastSnapshot.sequence}`,kind:'context',title:'会话上下文快照读取失败',at:lastSnapshot.at,sequences:[lastSnapshot.sequence],fields:[field('error','读取错误',native.error)]});
    else if (native) {
      const messages = native.filter(row=>['_system_prompt','system','user','assistant','tool'].includes(row.role));
      const nativeFields = list=>list.map((row,i)=>field(`message-${i}`, { _system_prompt:'系统指令',system:'系统消息',user:'用户消息',assistant:'模型消息',tool:`工具结果 · ${row.tool_call_id ?? ''}`}[row.role] || row.role, row.tool_calls?.length ? {content:row.content,tool_calls:row.tool_calls} : row.content, row.role==='user'));
      const allFields = nativeFields(messages);
      contexts.push({id:`snapshot:${lastSnapshot.sequence}`,kind:'context',title:`结束时会话上下文 · ${messages.length} 条消息`,at:lastSnapshot.at,sequences:[lastSnapshot.sequence],fields:allFields,note:'来自 Kimi 原生 context.jsonl 快照。包含保存的系统指令与消息；工具定义及完整 HTTP 请求未由该快照提供。'});
      // Checkpoints are storage boundaries, not HTTP request records. Only map this
      // turn when the prompt and all step boundaries survive without compaction.
      const userIndex = native.findLastIndex(row=>row.role==='user' && row.content===prompt?.payload.text);
      const boundaries = native.flatMap((row,i)=>i>userIndex && row.role==='_checkpoint' ? [i] : []);
      if (userIndex >= 0 && boundaries.length===steps.size && messages.length*steps.size<=200000 && !entries.some(item=>item.kind==='compaction')) {
        [...steps.values()].forEach((item,i)=>{
          const list = native.slice(0,boundaries[i]).filter(row=>['_system_prompt','system','user','assistant','tool'].includes(row.role));
          item.contextId = `step-context:${item.id}`;
          contexts.push({id:item.contextId,kind:'context',stepId:item.id,title:`${item.title} · ${list.length} 条上下文消息`,at:item.at,sequences:[lastSnapshot.sequence],usage:item.usage,contextUsage:item.contextUsage,fields:allFields.slice(0,list.length),note:'按 Kimi 原生 Checkpoint 边界展示保存的上下文，不包含这一步之后的回复和工具结果。工具定义及完整 HTTP 请求未记录。'});
        });
      }
    }
  }
  for (const item of entries) {if (item.stepId) item.contextId = steps.get(item.stepId)?.contextId;}
  for (const item of contexts) item.summary = item.note || preview(item.fields[0]?.text ?? '');
  return {entries,contexts,tools:entries.filter(item=>item.kind==='tool'),totalRecords:records.length,model:start?.payload.model?.model ?? null};
}
function descriptor(entry) {
  const {fields,...rest} = entry;
  return {...rest,fields:fields.map(({text,...field})=>({...field,bytes:Buffer.byteLength(text)}))};
}
module.exports = {projectEvents, descriptor};
