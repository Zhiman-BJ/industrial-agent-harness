import {useEffect,useRef,useState} from 'react';
import {Maximize} from 'lucide-react';
export interface WaveData {url:string;name:string;defaultSignals?:string[];initialRange?:[number,number]}
export interface SignalRequest {name:string;id:number}
export function WaveformViewport({data,onReady,onError,signal}:{data:WaveData;onReady:()=>void;onError:(message:string)=>void;signal?:SignalRequest}) {
  const frame=useRef<HTMLIFrameElement>(null);
  const pending=useRef(new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>());
  const sequence=useRef(0);const available=useRef(false);const loadedRef=useRef(false);
  const [attempt,setAttempt]=useState(0);
  const [loaded,setLoaded]=useState(false);const [error,setError]=useState('');
  const callbacks=useRef({onReady,onError});callbacks.current={onReady,onError};
  const src=`app://surfer/index.html?${new URLSearchParams({host_origin:window.location.origin,attempt:String(attempt)})}`;
  function command(action:string,payload:unknown):Promise<any> {
    return new Promise((resolve,reject)=>{
      if(!available.current)return reject(Error('Waveform viewer is not ready.'));
      const id=++sequence.current;
      const timer=setTimeout(()=>{pending.current.delete(id);reject(Error('Waveform viewer did not respond.'));},15000);
      pending.current.set(id,{resolve,reject,timer});
      frame.current?.contentWindow?.postMessage({channel:'silicon-host',id,action,payload},'app://surfer');
    });
  }
  function fail(message:string){if(!loadedRef.current&&attempt===0){setLoaded(false);setAttempt(1);return;}setError(message);callbacks.current.onError(message);}
  useEffect(()=>{
    let ended=false,loadSent=false;loadedRef.current=false;available.current=false;setLoaded(false);setError('');
    const timer=setTimeout(()=>{if(!loadedRef.current&&!ended)fail('Waveform loading exceeded 60 seconds.');},60000);
    console.info('WAVE start',data.url,attempt,frame.current?.getBoundingClientRect().width);
    const listener=(event:MessageEvent)=>{
      if(event.source!==frame.current?.contentWindow||event.origin!=='app://surfer'||event.data?.channel!=='silicon-surfer')return;
      const message=event.data;if(message.event)console.info('WAVE event',message.event,attempt,frame.current?.getBoundingClientRect().width);
      if(message.event==='ready'){
        available.current=true;
        if(!loadSent){loadSent=true;void command('load',data.url).catch(e=>{if(!ended)fail(e.message);});}
      }
      if(message.event==='loaded'){loadedRef.current=true;setLoaded(true);clearTimeout(timer);}
      if(message.event==='error'){clearTimeout(timer);fail(String(message.message));}
      const request=pending.current.get(message.id);
      if(request){clearTimeout(request.timer);pending.current.delete(message.id);message.error?request.reject(Error(message.error)):request.resolve(message.result);}
    };
    window.addEventListener('message',listener);
    // Reconcile state even if an iframe's one-shot ready/loaded notification was missed.
    const poll=setInterval(()=>{if(!loadedRef.current)frame.current?.contentWindow?.postMessage({channel:'silicon-host',id:0,action:'status'},'app://surfer');},1000);
    return()=>{ended=true;clearInterval(poll);clearTimeout(timer);window.removeEventListener('message',listener);available.current=false;for(const p of pending.current.values()){clearTimeout(p.timer);p.reject(Error('Waveform changed.'));}pending.current.clear();};
  },[data.url,attempt]);
  useEffect(()=>{
    if(!loaded)return;
    let cancelled=false;
    const names=data.defaultSignals??[];
    void (async()=>{
      await command('presentation',null);
      if(names.length){
        await command('commands',names.map(name=>`variable_add ${name}`).join('\n')+'\n'+(data.initialRange?`zoom_to ${data.initialRange[0]} ${data.initialRange[1]}`:'zoom_fit'));
        const deadline=performance.now()+15000;
        while(!cancelled){
          const result=await command('probe',names);
          if(result.ids?.every((item:{id:unknown})=>item.id!=null))break;
          if(performance.now()>deadline)throw Error('Waveform signals did not become visible.');
          await new Promise(resolve=>setTimeout(resolve,100));
        }
      }
      if(!cancelled){frame.current?.setAttribute('data-signals-ready',String(names.length));callbacks.current.onReady();}
    })().catch(e=>{if(!cancelled)fail(e.message);});
    return()=>{cancelled=true;};
  },[loaded,data.url,attempt]);
  useEffect(()=>{
    if(!loaded||!signal)return;
    // Mapping values are identifiers, never arbitrary Surfer commands.
    if(!/^[A-Za-z_][A-Za-z0-9_.$\[\]:/\\-]*$/.test(signal.name)){fail('Signal mapping contains an unsupported identifier.');return;}
    let cancelled=false;
    void command('probe',[signal.name]).then(async result=>{
      if(cancelled)return;
      if(result.ids?.[0]?.id==null)await command('commands',`variable_add ${signal.name}`);
    }).catch(e=>{if(!cancelled)fail(e.message);});
    return()=>{cancelled=true;};
  },[signal,loaded]);
  return <div className="rp-surfer"><div className="rp-view-tools"><span className="rp-tool-caption">{data.name}</span><button disabled={!loaded} onClick={()=>void command('commands','toggle_side_panel').catch(e=>fail(e.message))}>Signals</button><button disabled={!loaded} aria-label="Fit waveform" title="Show full simulation" onClick={()=>void command('commands','zoom_fit').catch(e=>fail(e.message))}><Maximize size={14}/></button></div><iframe key={attempt} ref={frame} src={src} title="Waveform viewer" allow="clipboard-write"/>{!loaded&&!error?<div className="rp-loading">{attempt?'Reloading waveform…':'Loading waveform…'}</div>:null}{error?<div className="rp-view-error" role="alert">{error}<button onClick={()=>{setLoaded(false);setAttempt(n=>n+1);}}>Retry</button></div>:null}</div>;
}
