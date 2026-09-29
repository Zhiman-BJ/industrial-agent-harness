const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {projectEvents, descriptor} = require('./diagnostic-view.cjs');
const {defaultLogDirectory, projectLogDirectory} = require('./diagnostic-log.cjs');
const namePattern = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const maxFileBytes = 64 * 1024 * 1024;
const maxRecordBytes = 16 * 1024 * 1024;
const chunkBytes = 64 * 1024;
function category(row) {
  const event = typeof row.payload?.type==='string' ? row.payload.type : '';
  if (row.type === 'harness.event') return 'ui';
  if (row.type === 'sdk.event') {
    if (event.startsWith('Tool')) return 'tools';
    if (event.startsWith('Compaction') || event === 'StatusUpdate') return 'context';
    if (event.startsWith('Approval')) return 'approvals';
    if (event === 'ContentPart' && row.payload.payload?.type === 'think') return 'thinking';
  }
  if (row.type === 'approval.response') return 'approvals';
  if (row.type.startsWith('context.') || row.type.startsWith('kimi.snapshot')) return 'context';
  return 'run';
}
function summary(row) {
  const event = row.payload || {}, payload = event.payload || {};
  if (row.type === 'sdk.event' && event.type === 'ToolCall') return payload.function?.name || 'Tool call';
  if (row.type === 'sdk.event' && event.type === 'ToolResult') return `${payload.return_value?.is_error ? 'Failed' : 'Finished'} · ${payload.tool_call_id || ''}`;
  if (row.type === 'sdk.event' && event.type === 'StatusUpdate') return `Context ${typeof payload.context_usage === 'number' ? `${Math.round(payload.context_usage * 100)}%` : '—'} · ${payload.token_usage?.output ?? '—'} output tokens`;
  if (row.type === 'prompt') return typeof event.text==='string' ? event.text.split('User task: ').at(-1) : 'Prompt';
  if (row.type === 'run.end') return event.status || 'Run ended';
  if (row.type === 'kimi.snapshot') return `${event.phase} · ${event.kind} · ${event.bytes} bytes`;
  return event.message || event.text || payload.text || payload.think || '';
}
function readMetrics(value) {
  if(!value || typeof value!=='object')return null;
  const number=key=>typeof value[key]==='number'&&Number.isFinite(value[key])&&value[key]>=0 ? value[key] : null;
  return {peakContextUsage:number('peakContextUsage'),compactions:number('compactions'),toolResults:number('toolResults')};
}
function canonicalDirectory(directory) {
  let parent=path.resolve(directory);
  while(true) {
    try {return path.join(fs.realpathSync(parent),path.relative(parent,path.resolve(directory)));}
    catch(error){if(error.code!=='ENOENT'||path.dirname(parent)===parent)throw error;parent=path.dirname(parent);}
  }
}
class DiagnosticReader {
  constructor(directory = defaultLogDirectory()) {this.suppliedDirectory = path.resolve(directory); this.directory = canonicalDirectory(directory); this.cache = new Map();}
  async folder(project) {
    const folder = projectLogDirectory(project, this.directory);
    try {
      if (await fs.promises.realpath(this.directory) !== this.directory || await fs.promises.realpath(folder) !== folder) throw Error('Diagnostic log directory must not be a symlink.');
      return folder;
    } catch (error) {if (error.code === 'ENOENT') return null; throw error;}
  }
  async open(project, runId) {
    if (typeof runId !== 'string' || !namePattern.test(runId)) throw Error('Invalid diagnostic run ID.');
    const folder = await this.folder(project);
    if (!folder) throw Error('Diagnostic log is unavailable.');
    const file = path.join(folder, runId);
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      if (await fs.promises.realpath(file) !== file) throw Error('Diagnostic log must not be a symlink.');
      const stat = await handle.stat(), current = await fs.promises.lstat(file);
      if (!current.isFile() || current.ino!==stat.ino || current.dev!==stat.dev) throw Error('Diagnostic log changed while opening.');
      if (!stat.isFile() || stat.size > maxFileBytes) throw Error('Diagnostic log exceeds the 64 MiB viewing limit.');
      return {handle, stat, file, traceId: namePattern.exec(runId)[2]};
    } catch (error) {await handle.close(); throw error;}
  }
  async list(project) {
    const folder = await this.folder(project);
    if (!folder) return {runs: [], limited:false};
    const candidates = [];
    let visited = 0;
    const directory = await fs.promises.opendir(folder);
    for await (const item of directory) {
      if (++visited > 5000) break;
      if (item.isFile() && namePattern.test(item.name)) candidates.push(item.name);
    }
    const names = candidates.sort().reverse().slice(0,50);
    const runs = [];
    for (const runId of names) {
      let opened;
      try {
        opened = await this.open(project, runId);
        const {handle, stat, traceId} = opened;
        const head = Buffer.alloc(Math.min(stat.size, chunkBytes));
        await handle.read(head,0,head.length,0);
        const firstLine = head.indexOf(10);
        let start = null;
        if (firstLine >= 0) {try {const row=JSON.parse(head.subarray(0,firstLine).toString('utf8')); if(row.traceId===traceId && row.type==='run.start')start=row;} catch {}}
        const tail = Buffer.alloc(Math.min(stat.size,chunkBytes));
        await handle.read(tail,0,tail.length,stat.size-tail.length);
        const lastLine = tail.toString('utf8').trimEnd().split('\n').at(-1);
        let end = null;
        try {const row=JSON.parse(lastLine); if(row.traceId===traceId && row.type==='run.end')end=row;} catch {}
        runs.push({runId,traceId,at:start?.at || namePattern.exec(runId)[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z'),sizeBytes:stat.size,model:typeof start?.payload?.model?.model==='string'?start.payload.model.model.slice(0,160):null,status:typeof end?.payload?.status==='string'?end.payload.status.slice(0,40):null,metrics:readMetrics(end?.payload?.metrics)});
      } catch (error) {runs.push({runId,traceId:namePattern.exec(runId)[2],at:namePattern.exec(runId)[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z'),sizeBytes:null,model:null,status:null,metrics:null,error:String(error.message)});}
      finally {await opened?.handle.close();}
    }
    return {runs,limited:candidates.length>50 || visited>5000};
  }
  async index(opened) {
    const {handle, stat, file, traceId} = opened;
    const cached = this.cache.get(file);
    if (cached && cached.size===stat.size && cached.mtime===stat.mtimeMs && cached.ino===stat.ino) return cached;
    // Append-only runs resume at the last complete record; rewrites start again.
    const append = cached && cached.size<stat.size && cached.ino===stat.ino;
    const rows = append ? [...cached.rows] : [];
    let cursor = append ? cached.cursor : 0, pending = Buffer.alloc(0);
    if (stat.size>cursor) {
      let position = cursor;
      while (position < stat.size) {
          const bytes = Buffer.alloc(Math.min(chunkBytes,stat.size-position));
          const {bytesRead} = await handle.read(bytes,0,bytes.length,position);
          if (bytesRead !== bytes.length) throw Error('Diagnostic log changed while indexing.');
          position += bytesRead;
          pending = Buffer.concat([pending,bytes]);
          let newline;
          while ((newline=pending.indexOf(10))>=0) {
            if (newline>maxRecordBytes) throw Error('Diagnostic record exceeds the 16 MiB viewing limit.');
            const raw = pending.subarray(0,newline).toString('utf8');
            if (raw.trim()) {
              let row;
              try {row=JSON.parse(raw);} catch {throw Error(`Malformed diagnostic record at byte ${cursor}.`);}
              if (row.schemaVersion!==1 || row.traceId!==traceId || row.sequence!==rows.length+1 || typeof row.type!=='string' || row.type.length>100 || typeof row.at!=='string' || row.at.length>64) throw Error('Diagnostic record identity or sequence is inconsistent.');
              rows.push({sequence:row.sequence,at:row.at,type:row.type,event:typeof row.payload?.type==='string' ? row.payload.type.slice(0,100) : null,category:category(row),summary:String(summary(row)).slice(0,180),offset:cursor,bytes:newline});
              if (rows.length>100000) throw Error('Diagnostic log exceeds 100,000 records.');
            }
            cursor+=newline+1; pending=pending.subarray(newline+1);
          }
          if (pending.length>maxRecordBytes) throw Error('Diagnostic record exceeds the 16 MiB viewing limit.');
      }
    }
    const result={rows,cursor,size:stat.size,mtime:stat.mtimeMs,ino:stat.ino,pending:pending.length>0};
    this.cache.delete(file);this.cache.set(file,result);
    while(this.cache.size>16 || [...this.cache.values()].reduce((sum,item)=>sum+item.rows.length,0)>200000)this.cache.delete(this.cache.keys().next().value);
    return result;
  }
  async page(project, {runId, offset=0, category:filter='all', query=''} = {}) {
    if (!Number.isSafeInteger(offset) || offset<0 || offset>100000 || !['all','tools','context','thinking','approvals','run','ui'].includes(filter) || typeof query!=='string' || query.length>200) throw Error('Invalid diagnostic page request.');
    const opened = await this.open(project,runId);
    try {
      const index = await this.index(opened), needle=query.toLowerCase();
      const rows=index.rows.filter(row=>(filter==='all'||row.category===filter) && (!needle||`${row.type} ${row.event} ${row.summary}`.toLowerCase().includes(needle)));
      const counts=Object.fromEntries(['tools','context','thinking','approvals','run','ui'].map(kind=>[kind,index.rows.filter(row=>row.category===kind).length]));
      return {records:rows.slice(offset,offset+100),nextOffset:offset+100<rows.length?offset+100:null,total:rows.length,totalRecords:index.rows.length,counts,pending:index.pending};
    } finally {await opened.handle.close();}
  }
  async projection(opened, project) {
    const index = await this.index(opened);
    const signature = `${opened.file}:${index.size}:${index.mtime}:${index.ino}`;
    if (this.viewCache?.signature === signature) return this.viewCache.value;
    const buffer = Buffer.alloc(index.cursor);
    const {bytesRead} = await opened.handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length) throw Error('Diagnostic log changed while reading.');
    const records = buffer.toString('utf8').split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));
    const snapshots = new Map();
    for (const row of records.filter(row=>row.type==='kimi.snapshot' && row.payload?.kind==='context' && row.payload.phase==='after-turn')) {
      let handle;
      try {
        const expected = path.join(path.dirname(opened.file), `${opened.traceId}.after-turn.context.jsonl`);
        const logical = path.join(projectLogDirectory(project,this.suppliedDirectory), `${opened.traceId}.after-turn.context.jsonl`);
        if (![expected,logical].includes(row.payload.path) || !Number.isSafeInteger(row.payload.bytes) || row.payload.bytes < 0 || row.payload.bytes > maxFileBytes) throw Error('Invalid context snapshot metadata.');
        handle = await fs.promises.open(expected, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== row.payload.bytes || await fs.promises.realpath(expected) !== expected) throw Error('Context snapshot identity or size is inconsistent.');
        const bytes = await handle.readFile();
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== row.payload.sha256) throw Error('Context snapshot hash is inconsistent.');
        const native = bytes.toString('utf8').split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));
        if (native.length > 100000) throw Error('Context snapshot exceeds 100,000 records.');
        snapshots.set(row.sequence, native);
      } catch (error) {snapshots.set(row.sequence, {error: String(error.message)});}
      finally {await handle?.close();}
    }
    const value = projectEvents(records, snapshots);
    this.viewCache = {signature, value}; // Only one run's full content is cached.
    return value;
  }
  async view(project, {runId, view='timeline', offset=0, query=''} = {}) {
    if (!['timeline','context','tools'].includes(view) || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || typeof query !== 'string' || query.length > 200) throw Error('Invalid diagnostic view request.');
    const opened = await this.open(project, runId);
    try {
      const value = await this.projection(opened, project), needle=query.toLowerCase();
      const source = view==='timeline' ? value.entries : view==='context' ? value.contexts : value.tools;
      const filtered = source.filter(item=>!needle || `${item.title} ${item.summary} ${item.callId ?? ''}`.toLowerCase().includes(needle));
      return {entries:filtered.slice(offset,offset+100).map(descriptor),nextOffset:offset+100<filtered.length?offset+100:null,total:filtered.length,totalRecords:value.totalRecords,counts:{timeline:value.entries.length,context:value.contexts.length,tools:value.tools.length}};
    } finally {await opened.handle.close();}
  }
  async detail(project, {runId, id, field, offset=0} = {}) {
    if (typeof id !== 'string' || id.length > 100 || typeof field !== 'string' || field.length > 100 || !Number.isSafeInteger(offset) || offset < 0) throw Error('Invalid diagnostic detail request.');
    const opened = await this.open(project, runId);
    try {
      const value = await this.projection(opened, project);
      const entry = [...value.entries,...value.contexts].find(item=>item.id===id);
      const part = entry?.fields.find(item=>item.key===field);
      if (!part) throw Error('Diagnostic field is unavailable.');
      const bytes = Buffer.from(part.text);
      if (offset > bytes.length || (bytes[offset] & 0xc0) === 0x80) throw Error('Invalid diagnostic text offset.');
      let end = Math.min(offset+chunkBytes,bytes.length);
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      return {text:bytes.subarray(offset,end).toString('utf8'),offset,nextOffset:end<bytes.length?end:null,totalBytes:bytes.length};
    } finally {await opened.handle.close();}
  }
  async record(project, {runId, sequence, offset=0} = {}) {
    if(!Number.isSafeInteger(sequence)||sequence<1||!Number.isSafeInteger(offset)||offset<0)throw Error('Invalid diagnostic record request.');
    const opened=await this.open(project,runId);
    try {
      const index=await this.index(opened),row=index.rows.find(row=>row.sequence===sequence);
      if(!row || offset>=row.bytes)throw Error('Diagnostic record is unavailable.');
      const buffer=Buffer.alloc(Math.min(chunkBytes,row.bytes-offset));
      const {bytesRead}=await opened.handle.read(buffer,0,buffer.length,row.offset+offset);
      if(bytesRead!==buffer.length)throw Error('Diagnostic log changed while reading.');
      if((buffer[0]&0xc0)===0x80)throw Error('Invalid diagnostic text offset.');
      let end=buffer.length;
      if(offset+end<row.bytes) {
        // Keep UTF-8 code points intact across payload chunks.
        let lead=end-1;while(lead>=0&&(buffer[lead]&0xc0)===0x80)lead--;
        const byte=buffer[lead], length=byte<0x80?1:byte<0xe0?2:byte<0xf0?3:4;
        if(end-lead<length)end=lead;
      }
      return {text:buffer.subarray(0,end).toString('utf8'),offset,nextOffset:offset+end<row.bytes?offset+end:null,totalBytes:row.bytes};
    } finally {await opened.handle.close();}
  }
}
module.exports={DiagnosticReader};
