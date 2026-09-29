import {useEffect, useRef, useState} from 'react';
import type {DiagnosticCategory, DiagnosticContent, DiagnosticEntry, DiagnosticField, DiagnosticPage, DiagnosticRecord, DiagnosticRun, DiagnosticView, DiagnosticViewPage} from '@industrial-agent-harness/viewer-builtin/api';

const categories: Array<[DiagnosticCategory | 'all', string]> = [['all','全部事件'],['tools','工具事件'],['context','上下文与压缩'],['thinking','思考'],['approvals','审批'],['run','运行与会话'],['ui','界面事件']];
const views: Array<[DiagnosticView, string]> = [['timeline','时间线'],['context','上下文'],['tools','工具调用']];
const statusNames: Record<string,string> = {running:'进行中',success:'成功',error:'失败',unknown:'状态未记录',missing:'未记录返回',finished:'已完成',completed:'已完成',interrupted:'已中断',cancelled:'已取消'};
const stamp = (at: string) => {const value = new Date(at); return Number.isNaN(value.getTime()) ? at : value.toLocaleString();};
const time = (at: string) => {const value = new Date(at); return Number.isNaN(value.getTime()) ? at : value.toLocaleTimeString();};
const bytes = (value: number) => value >= 1024 ? `${(value/1024).toFixed(1)} KB` : `${value} B`;
function readable(content: DiagnosticContent) {
  if (content.offset === 0 && content.nextOffset === null) {try {return JSON.stringify(JSON.parse(content.text),null,2);} catch {}}
  return content.text;
}
function ContentViewer({projectId,runId,id,field,sequence,revision,prose=false}: {projectId:string;runId:string;id?:string;field?:string;sequence?:number;revision:number;prose?:boolean}) {
  const [content,setContent]=useState<DiagnosticContent>(), [offset,setOffset]=useState(0), [previous,setPrevious]=useState<number[]>([]), [error,setError]=useState('');
  useEffect(()=>{
    let cancelled=false; setContent(undefined);setError('');
    const request = sequence != null ? window.viewerHost!.diagnosticRecord({projectId,runId,sequence,offset}) : window.viewerHost!.diagnosticDetail({projectId,runId,id:id!,field:field!,offset});
    request.then(value=>{if(!cancelled)setContent(value);}).catch(reason=>{if(!cancelled)setError(String(reason));});
    return()=>{cancelled=true;};
  },[projectId,runId,id,field,sequence,offset,revision]);
  return <>{error&&<p role="alert" className="ia-log-error">{error}</p>}{!content&&!error&&<p>正在读取…</p>}{content&&<>
    {sequence!=null&&<small>{content.totalBytes.toLocaleString()} bytes · {content.offset===0&&content.nextOffset===null?'Complete record':`Bytes ${content.offset+1}–${content.nextOffset??content.totalBytes}`}</small>}
    <pre className={prose?'ia-log-prose':sequence!=null?'ia-log-tool-content ia-log-raw':'ia-log-tool-content'}>{prose?content.text:readable(content)}</pre>
    {(content.offset>0||content.nextOffset!=null)&&<footer><span>{bytes(content.totalBytes)} · 当前为部分内容</span><button disabled={!previous.length} onClick={()=>{setOffset(previous.at(-1)!);setPrevious(value=>value.slice(0,-1));}}>Previous part</button><button disabled={content.nextOffset==null} onClick={()=>{setPrevious(value=>[...value,offset]);setOffset(content.nextOffset!);}}>Next part</button></footer>}
  </>}</>;
}
function FieldSection({entry,field,projectId,runId,revision}: {entry:DiagnosticEntry;field:DiagnosticField;projectId:string;runId:string;revision:number}) {
  const [open,setOpen]=useState(field.open);
  return <details className="ia-log-field" open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary><b>{field.label}</b><small>{bytes(field.bytes)}</small></summary>{open&&<ContentViewer projectId={projectId} runId={runId} id={entry.id} field={field.key} revision={revision} prose={['text','thinking'].includes(field.key)}/>}</details>;
}
function SourceEvent({sequence,projectId,runId,revision}: {sequence:number;projectId:string;runId:string;revision:number}) {
  const [open,setOpen]=useState(false);
  return <details open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>事件 #{sequence}</summary>{open&&<ContentViewer projectId={projectId} runId={runId} sequence={sequence} revision={revision}/>}</details>;
}
function SourceEvents({entry,projectId,runId,revision}: {entry:DiagnosticEntry;projectId:string;runId:string;revision:number}) {
  const [open,setOpen]=useState(false);
  return <details className="ia-log-source-events" open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>关联原始事件 · {entry.sequences.length} 条</summary>{open&&<div>{entry.sequences.map(sequence=><SourceEvent key={sequence} sequence={sequence} projectId={projectId} runId={runId} revision={revision}/>)}</div>}</details>;
}
function Usage({entry}: {entry:DiagnosticEntry}) {
  if (!entry.usage && entry.contextUsage==null) return null;
  const usage=entry.usage;
  const input=usage&&['input_other','input_cache_read','input_cache_creation'].some(key=>usage[key]!=null) ? ['input_other','input_cache_read','input_cache_creation'].reduce((sum,key)=>sum+(usage[key]??0),0) : null;
  return <div className="ia-log-usage">{entry.contextUsage!=null&&<span>上下文占用 <b>{(entry.contextUsage*100).toFixed(1)}%</b></span>}{input!=null&&<span>输入 <b>{input.toLocaleString()} tokens</b></span>}{usage?.output!=null&&<span>输出 <b>{usage.output.toLocaleString()} tokens</b></span>}</div>;
}
export function AgentLogPanel({projectId, projectName, initialTraceId, runningTraceId, running, onClose}: {projectId: string; projectName: string; initialTraceId?: string; runningTraceId?: string; running: boolean; onClose: () => void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [runs,setRuns]=useState<DiagnosticRun[]>([]), [limited,setLimited]=useState(false);
  const [runId,setRunId]=useState(''), [view,setView]=useState<DiagnosticView|'raw'>('timeline'), [category,setCategory]=useState<DiagnosticCategory|'all'>('all');
  const [query,setQuery]=useState(''), [search,setSearch]=useState(''), [offset,setOffset]=useState(0);
  const [page,setPage]=useState<DiagnosticViewPage>(), [rawPage,setRawPage]=useState<DiagnosticPage>();
  const [selectedId,setSelectedId]=useState(''), [rawSelected,setRawSelected]=useState<DiagnosticRecord>();
  const [error,setError]=useState(''), [loading,setLoading]=useState(false), [refresh,setRefresh]=useState(0);
  const [jump,setJump]=useState<{id:string;view:DiagnosticView}|null>(null);
  const run=runs.find(item=>item.runId===runId);
  const selected=page?.entries.find(item=>item.id===selectedId);
  useEffect(()=>{const node=dialog.current!;const previous=document.activeElement;node.showModal();return()=>{node.close();if(previous instanceof HTMLElement)previous.focus();};},[]);
  useEffect(()=>{const timer=setTimeout(()=>{setSearch(query.trim().slice(0,200));setOffset(0);},200);return()=>clearTimeout(timer);},[query]);
  useEffect(()=>{
    let cancelled=false;
    window.viewerHost!.diagnosticRuns({projectId}).then(result=>{
      if(cancelled)return;setRuns(result.runs);setLimited(result.limited);
      const requested=result.runs.find(item=>item.traceId===initialTraceId);
      if(initialTraceId&&!requested)setError('指定运行不在可用日志中，请选择其他运行。');
      setRunId(current=>result.runs.some(item=>item.runId===current)?current:requested?.runId || (initialTraceId?'':result.runs[0]?.runId||''));
    }).catch(reason=>{if(!cancelled)setError(String(reason));});
    return()=>{cancelled=true;};
  },[projectId,initialTraceId,refresh]);
  useEffect(()=>{
    if(!runId)return;
    let cancelled=false;setLoading(true);setError('');
    const request=view==='raw' ? window.viewerHost!.diagnosticPage({projectId,runId,category,query:search,offset}) : window.viewerHost!.diagnosticView({projectId,runId,view,query:search,offset});
    request.then(result=>{
      if(cancelled)return;
      if('entries' in result){setPage(result);setSelectedId(current=>result.entries.some(item=>item.id===current)?current:result.entries[0]?.id||'');}
      else {setRawPage(result);setRawSelected(current=>result.records.find(item=>item.sequence===current?.sequence)??result.records[0]);}
    }).catch(reason=>{if(!cancelled){setPage(undefined);setRawPage(undefined);setError(String(reason));}}).finally(()=>{if(!cancelled)setLoading(false);});
    return()=>{cancelled=true;};
  },[projectId,runId,view,category,search,offset,refresh]);
  useEffect(()=>{
    if(!jump || view!==jump.view || !page || loading)return;
    if(page.entries.some(item=>item.id===jump.id)){setSelectedId(jump.id);setJump(null);}
    else if(page.nextOffset!=null)setOffset(page.nextOffset);
    else {setError('这条关联记录当前不可用。');setJump(null);}
  },[jump,view,page,loading]);
  useEffect(()=>{setRefresh(value=>value+1);if(!running)return;const timer=setInterval(()=>setRefresh(value=>value+1),2000);return()=>clearInterval(timer);},[running]);
  function chooseRun(id:string){setRunId(id);setPage(undefined);setRawPage(undefined);setOffset(0);setSelectedId('');setRawSelected(undefined);setJump(null);setError('');}
  function chooseView(next:DiagnosticView|'raw'){setView(next);setPage(undefined);setRawPage(undefined);setOffset(0);setSelectedId('');setRawSelected(undefined);setJump(null);}
  function navigate(next:DiagnosticView,id:string){chooseView(next);setQuery('');setSearch('');setJump({view:next,id});}
  const nextOffset=view==='raw'?rawPage?.nextOffset:page?.nextOffset;
  const count=view==='raw'?rawPage?.total:page?.total;
  return <dialog ref={dialog} className="ia-agent-log" aria-labelledby="ia-log-title" onCancel={event=>{event.preventDefault();onClose();}}>
    <header><div><h2 id="ia-log-title">Agent 运行日志</h2><span>{projectName} · 查看执行过程、上下文和工具结果</span></div><button aria-label="Close agent logs" onClick={onClose}>×</button></header>
    <div className="ia-log-body"><aside className="ia-log-runs"><div className="ia-log-section-title"><b>历史运行</b><button onClick={()=>setRefresh(value=>value+1)} aria-label="Refresh agent logs">刷新</button></div>
      {!runs.length&&<p>暂无日志。在项目中运行任务后即可查看。</p>}{runs.map(item=><button key={item.runId} className={runId===item.runId?'selected':''} onClick={()=>chooseRun(item.runId)} title={item.traceId}><time>{stamp(item.at)}</time><b>{item.model||'Agent run'}</b><small>{item.traceId.slice(0,8)} · {item.traceId===runningTraceId&&running?'Running · 进行中':statusNames[item.status??'']||item.status||'未记录结束'}</small>{item.error&&<small>{item.error}</small>}</button>)}{limited&&<p>显示最近 50 次运行。</p>}
    </aside><div className="ia-log-workspace">
      <nav className="ia-log-tabs" aria-label="日志视图">{views.map(([value,label])=><button key={value} aria-pressed={view===value} className={view===value?'active':''} onClick={()=>chooseView(value)}>{label}{page&&view!=='raw'&&<small>{page.counts[value]}</small>}</button>)}<button className={`ia-log-raw-tab ${view==='raw'?'active':''}`} aria-pressed={view==='raw'} onClick={()=>chooseView('raw')}>原始事件</button></nav>
      {run&&<div className="ia-log-run-info"><span><b>{run.model||'Agent run'}</b> · {run.metrics?.peakContextUsage==null?'上下文占用未记录':`Peak context ${Math.round(run.metrics.peakContextUsage*100)}%`} · {run.metrics?.compactions??'—'} 次压缩</span><small>{view==='raw'?`${rawPage?.totalRecords??'—'} 条原始事件`:`${page?.totalRecords??'—'} 条原始事件 → ${page?.counts.timeline??'—'} 条时间线记录`} · Trace {run.traceId}</small></div>}
      <div className="ia-log-content"><section className="ia-log-events">
        <div className="ia-log-filters">{view==='raw'&&<label>事件类型<select aria-label="Agent log event type" value={category} onChange={event=>{setCategory(event.target.value as DiagnosticCategory|'all');setOffset(0);setRawSelected(undefined);}}>{categories.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>}<label><span>{view==='timeline'?'执行顺序':view==='context'?'上下文来源与模型步骤':view==='tools'?'调用与返回成对展示':'底层调试记录'}</span><input aria-label="Find agent log event" placeholder={view==='tools'?'搜索工具名、参数或调用 ID':'搜索记录'} maxLength={200} value={query} onChange={event=>setQuery(event.target.value)}/></label></div>
        {error&&<p className="ia-log-error" role="alert">{error}</p>}
        <div className="ia-log-records" aria-busy={loading}>{loading&&!page&&!rawPage&&<p>正在加载…</p>}
          {view!=='raw'&&page?.entries.map((entry,i)=><button key={entry.id} data-entry-id={entry.id} data-kind={entry.kind} className={selectedId===entry.id?'selected':''} onClick={()=>setSelectedId(entry.id)}><span className="ia-log-row-heading"><span className={`ia-log-kind kind-${entry.kind}`}>{entry.kind==='tool'?'↗':entry.kind==='user'?'你':entry.kind==='assistant'?'AI':entry.kind==='step'?'◈':entry.kind==='context'?'▤':'·'}</span><b>{view==='tools'?`${offset+i+1}. `:''}{entry.title}</b>{entry.status&&<em className={`ia-log-status status-${entry.status}`}>{statusNames[entry.status]||entry.status}</em>}</span><small>{time(entry.at)}{entry.durationMs!=null?` · ${(entry.durationMs/1000).toFixed(2)} 秒`:''}{entry.kind==='step'&&entry.contextUsage!=null?` · 上下文 ${(entry.contextUsage*100).toFixed(1)}%`:''}</small>{entry.summary&&<p>{entry.summary}</p>}</button>)}
          {view==='raw'&&rawPage?.records.map(row=><button key={row.sequence} className={rawSelected?.sequence===row.sequence?'selected':''} onClick={()=>setRawSelected(row)}><span><b>#{row.sequence} {row.event||row.type}</b><small>{row.type==='sdk.event'?'SDK':row.type==='harness.event'?'UI':'Harness'} · {time(row.at)}</small></span>{row.summary&&<p>{row.summary}</p>}</button>)}
          {count===0&&<p>{view==='context'?'没有可用的上下文记录。旧日志可能没有保存上下文快照。':'没有匹配的记录。'}</p>}
        </div><footer><span>{count==null?'':`${count} 条记录`}</span><button disabled={!offset||loading} onClick={()=>setOffset(value=>Math.max(0,value-100))}>Previous</button><button disabled={nextOffset==null||loading} onClick={()=>setOffset(nextOffset!)}>Next</button></footer>
      </section><section className="ia-log-detail">
        <div className="ia-log-section-title"><b>{view==='raw'?rawSelected?`Event #${rawSelected.sequence} · ${rawSelected.event||rawSelected.type}`:'原始事件':selected?.title||'记录详情'}</b>{selected?.status&&view!=='raw'&&<em className={`ia-log-status status-${selected.status}`}>{statusNames[selected.status]||selected.status}</em>}</div>
        {view!=='raw'&&selected&&<><div className="ia-log-detail-meta"><span>{stamp(selected.at)}</span>{selected.durationMs!=null&&<span>耗时 {(selected.durationMs/1000).toFixed(2)} 秒</span>}{selected.callId&&<code>{selected.callId}</code>}</div><Usage entry={selected}/>
          {(selected.contextId||selected.kind==='tool'||selected.stepId)&&<div className="ia-log-related">{selected.contextId&&<button onClick={()=>navigate('context',selected.contextId!)}>查看该步上下文 →</button>}{selected.kind==='tool'&&view!=='tools'&&<button onClick={()=>navigate('tools',selected.id)}>查看工具调用 →</button>}{view!=='timeline'&&<button onClick={()=>navigate('timeline',selected.kind==='tool'?selected.id:selected.stepId!)}>回到时间线 →</button>}</div>}
          {selected.note&&<p className="ia-log-context-note">{selected.note}</p>}{selected.kind==='step'&&!selected.contextId&&<p className="ia-log-context-note">未保存可对应此步骤的上下文边界。可在“上下文”查看本轮输入与现有会话快照。</p>}
          {selected.kind==='tool'&&selected.status==='missing'&&<p className="ia-log-context-note">运行已结束，但日志没有记录这次调用的返回。</p>}
          {selected.fields.map(field=><FieldSection key={`${runId}:${selected.id}:${field.key}`} entry={selected} field={field} projectId={projectId} runId={runId} revision={refresh}/>)}
          {!!selected.sequences.length&&<SourceEvents key={`${runId}:${selected.id}`} entry={selected} projectId={projectId} runId={runId} revision={refresh}/>}
        </>}
        {view==='raw'&&rawSelected&&<ContentViewer key={`${runId}:${rawSelected.sequence}`} projectId={projectId} runId={runId} sequence={rawSelected.sequence} revision={refresh}/>}
        {view!=='raw'&&!selected&&<p>选择一条记录查看完整内容。</p>}
      </section></div>
    </div></div><footer className="ia-log-note">只读日志 · 运行中自动刷新 · Esc 关闭</footer>
  </dialog>;
}
