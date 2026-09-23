import {useEffect,useRef,useState} from 'react';
import {ArrowUpRight,Maximize,Minus,Plus,Search} from 'lucide-react';
import type {NetlistData} from '../api';
function sanitizeSVG(text:string){
  const parsed=new DOMParser().parseFromString(text,'image/svg+xml');
  if(parsed.querySelector('parsererror')||parsed.documentElement.localName!=='svg')throw Error('Invalid netlist SVG.');
  const allowed=new Set(['svg','g','path','rect','line','circle','ellipse','polygon','polyline','text','tspan','title','desc']);
  for(const element of Array.from(parsed.querySelectorAll('*'))){
    if(!allowed.has(element.localName)){element.remove();continue;}
    for(const attr of Array.from(element.attributes))if(/^on/i.test(attr.name)||/href/i.test(attr.name)||/url\s*\(/i.test(attr.value))element.removeAttribute(attr.name);
  }
  return document.importNode(parsed.documentElement,true) as unknown as SVGSVGElement;
}
export function NetlistViewport({data,onReady,onError,onSignal,signalMap={}}:{data:NetlistData;onReady:()=>void;onError:(message:string)=>void;onSignal:(name:string)=>void;signalMap?:Record<string,string>}){
  const [net,setNet]=useState(data);const [query,setQuery]=useState('');const [selected,setSelected]=useState<string>();const [error,setError]=useState('');const [loading,setLoading]=useState(false);
  const stage=useRef<HTMLDivElement>(null);const drawing=useRef<HTMLDivElement>(null);
  const camera=useRef({x:0,y:0,scale:1});const controls=useRef<{fit:()=>void;zoom:(factor:number)=>void}|null>(null);
  const callbacks=useRef({onReady,onError});callbacks.current={onReady,onError};const generation=useRef(0);
  useEffect(()=>()=>{generation.current++;},[]);
  useEffect(()=>{
    const host=stage.current!,target=drawing.current!;let observer:ResizeObserver|undefined;
    try{
      const svg=sanitizeSVG(net.svg);const width=parseFloat(svg.getAttribute('width')??'800'),height=parseFloat(svg.getAttribute('height')??'400');
      if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw Error('Invalid netlist dimensions.');
      for(const cell of net.cells){const group=svg.querySelector(`[id="${CSS.escape('cell_'+cell.name)}"]`);if(group){const title=document.createElementNS('http://www.w3.org/2000/svg','title');title.textContent=`${cell.type} · ${cell.name}`;group.prepend(title);}}
      svg.setAttribute('aria-label',`${net.top} netlist`);target.replaceChildren(svg);
      let fitted=false;
      const draw=()=>{const c=camera.current;target.style.transform=`translate(${c.x}px,${c.y}px) scale(${c.scale})`;};
      const fit=()=>{if(!host.clientWidth||!host.clientHeight)return;const scale=Math.max(.02,Math.min((host.clientWidth-60)/width,(host.clientHeight-60)/height,2));camera.current={scale,x:(host.clientWidth-width*scale)/2,y:(host.clientHeight-height*scale)/2};draw();fitted=true;};
      const zoom=(factor:number,x=host.clientWidth/2,y=host.clientHeight/2)=>{const old=camera.current,next=Math.max(.02,Math.min(8,old.scale*factor)),ratio=next/old.scale;camera.current={scale:next,x:x-(x-old.x)*ratio,y:y-(y-old.y)*ratio};draw();};
      let drag:{x:number;y:number;camera:typeof camera.current}|null=null;
      const wheel=(e:WheelEvent)=>{e.preventDefault();const r=host.getBoundingClientRect();zoom(Math.exp(-Math.max(-160,Math.min(160,e.deltaY))*.002),e.clientX-r.left,e.clientY-r.top);};
      const down=(e:PointerEvent)=>{if(e.button!==0)return;drag={x:e.clientX,y:e.clientY,camera:{...camera.current}};host.setPointerCapture(e.pointerId);};
      const move=(e:PointerEvent)=>{if(!drag)return;camera.current={...drag.camera,x:drag.camera.x+e.clientX-drag.x,y:drag.camera.y+e.clientY-drag.y};draw();};
      const up=()=>{drag=null;};
      const click=(e:MouseEvent)=>{const classes=Array.from((e.target as Element).classList??[]);const bits=classes.find(c=>c.startsWith('net_'))?.slice(4).split(',');if(bits){const match=net.nets.find(n=>n.bits.some(b=>bits.includes(String(b))));if(match)setSelected(match.name);}};
      controls.current={fit,zoom};observer=new ResizeObserver(()=>{if(!fitted)fit();});observer.observe(host);fit();callbacks.current.onReady();
      host.addEventListener('wheel',wheel,{passive:false});host.addEventListener('pointerdown',down);host.addEventListener('pointermove',move);host.addEventListener('pointerup',up);host.addEventListener('pointercancel',up);host.addEventListener('lostpointercapture',up);host.addEventListener('click',click);
      return()=>{observer?.disconnect();host.removeEventListener('wheel',wheel);host.removeEventListener('pointerdown',down);host.removeEventListener('pointermove',move);host.removeEventListener('pointerup',up);host.removeEventListener('pointercancel',up);host.removeEventListener('lostpointercapture',up);host.removeEventListener('click',click);};
    }catch(e){const message=(e as Error).message;setError(message);callbacks.current.onError(message);}
    return()=>observer?.disconnect();
  },[net]);
  useEffect(()=>{
    const bits=new Set(net.nets.find(n=>n.name===selected)?.bits.filter(b=>typeof b==='number')??[]);
    for(const element of Array.from(drawing.current?.querySelectorAll('[class]')??[])){const active=Array.from(element.classList).some(c=>c.startsWith('net_')&&c.slice(4).split(',').some(b=>bits.has(Number(b))));element.classList.toggle('highlight',active);}
  },[selected,net]);
  async function changeModule(module:string,focus?:string){const request=++generation.current;setLoading(true);setError('');try{const result=await window.replayApi!.netlist({token:data.token,module,focus});if(request===generation.current){setNet({...result,token:data.token});setSelected(focus);}}catch(e){if(request===generation.current){setError((e as Error).message);callbacks.current.onError((e as Error).message);}}finally{if(request===generation.current)setLoading(false);}}
  return <div className="rp-netlist-native"><div className="rp-view-tools"><button aria-label="Zoom netlist in" onClick={()=>controls.current?.zoom(1.2)}><Plus size={15}/></button><button aria-label="Zoom netlist out" onClick={()=>controls.current?.zoom(1/1.2)}><Minus size={15}/></button><button aria-label="Fit netlist" onClick={()=>controls.current?.fit()}><Maximize size={15}/></button><span className="rp-tool-caption">{net.partial?`${net.cellCount} / ${net.totalCells} cells · local view (${net.focus})`:`${net.cellCount} cells`}</span><select aria-label="Netlist module" disabled={loading} value={net.top} onChange={e=>void changeModule(e.target.value)}>{net.modules.map(name=><option key={name}>{name}</option>)}</select></div><div className="rp-netlist-body"><aside><label className="rp-search"><Search size={13}/><input aria-label="Find net" placeholder="Find net" value={query} onChange={e=>setQuery(e.target.value)}/></label>{net.nets.filter(n=>n.name.toLowerCase().includes(query.toLowerCase())).map(n=><button className={selected===n.name?'selected':''} key={n.name} onClick={()=>setSelected(n.name)}><span>{n.name}</span><small>{n.bits.length} bit</small></button>)}<button disabled={!net.partial||!selected||loading} onClick={()=>selected&&void changeModule(net.top,selected)}>Focus signal</button><button className="rp-net-wave" disabled={!selected||!Object.hasOwn(signalMap,selected)} onClick={()=>selected&&onSignal(signalMap[selected])}>View in waveform <ArrowUpRight size={13}/></button></aside><div ref={stage} className="rp-net-stage"><div ref={drawing} className="rp-net-drawing"/></div></div>{loading?<div className="rp-loading">Laying out netlist…</div>:null}{error?<div className="rp-view-error" role="alert">{error}</div>:null}</div>;
}
