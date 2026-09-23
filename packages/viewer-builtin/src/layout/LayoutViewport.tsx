import {useEffect, useRef, useState} from 'react';
import {Layers, Maximize, Minus, Plus} from 'lucide-react';
import type {LayoutMeta} from '../api';

type Controls = {zoom:(factor:number)=>void; fit:()=>void; layers:(keys:string[])=>void; theme:(name:string)=>void};
export function LayoutViewport({meta,onReady,onError}: {meta:LayoutMeta;onReady:()=>void;onError:(message:string)=>void}) {
  const host = useRef<HTMLDivElement>(null); const canvas = useRef<HTMLCanvasElement>(null);
  const controls = useRef<Controls | undefined>(undefined); const ready = useRef(onReady); ready.current=onReady;const failure=useRef(onError);failure.current=onError;
  const [theme,setTheme]=useState('02_blueprint');
  const [visible,setVisible] = useState(meta.layers.map(l=>l.key)); const [error,setError] = useState('');
  const [layerMenu,setLayerMenu] = useState(false); const [span,setSpan] = useState('');
  useEffect(()=>{
    const element=host.current!, surface=canvas.current!, ctx=surface.getContext('2d')!;
    let disposed=false,busy=false,dirty=false,revision=0,styleRevision=0,lastInput=0;
    let timer:ReturnType<typeof setTimeout>|undefined,settle:ReturnType<typeof setTimeout>|undefined;
    let frame:{image:ImageBitmap;box:number[]}|null=null;
    let themeName='02_blueprint';
    let w=800,h=600,fitHeight=1,cam={x:0,y:0,h:1},keys=meta.layers.map(l=>l.key);
    let drag:{x:number;y:number;cam:typeof cam}|null=null;
    function box(){const width=cam.h*w/h;return [cam.x-width/2,cam.y-cam.h/2,cam.x+width/2,cam.y+cam.h/2];}
    function draw(){
      ctx.fillStyle=({ '01_neon':'#05090f','02_blueprint':'#071421','03_ember':'#120d13','04_routing':'#080c12' } as Record<string,string>)[themeName];ctx.fillRect(0,0,surface.width,surface.height);
      if(frame){const b=box(),scale=surface.height/cam.h;ctx.drawImage(frame.image,(frame.box[0]-b[0])*scale,(b[3]-frame.box[3])*scale,(frame.box[2]-frame.box[0])*scale,(frame.box[3]-frame.box[1])*scale);}
      setSpan(`${(cam.h*w/h).toFixed(1)} µm · ${(fitHeight/cam.h).toFixed(2)}×`);
    }
    function schedule(){if(!timer)timer=setTimeout(()=>{timer=undefined;void pump();},12);}
    function change(style=false){
      revision++;dirty=true;lastInput=performance.now();
      if(style){styleRevision++;frame?.image.close();frame=null;}
      draw();schedule();clearTimeout(settle);settle=setTimeout(()=>{dirty=true;schedule();},170);
    }
    async function pump(){
      if(disposed||busy||!dirty)return;
      busy=true;dirty=false;const version=revision,style=styleRevision;
      try{
        const result=await window.viewerHost!.render({token:meta.token,box:box(),width:surface.width,height:surface.height,visible:keys,theme:themeName,quality:performance.now()-lastInput<150?'fast':'fine'});
        const bytes=Uint8Array.from(atob(result.png),c=>c.charCodeAt(0));
        const image=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
        if(disposed||style!==styleRevision){image.close();return;}
        frame?.image.close();frame={image,box:result.box};draw();ready.current();
        if(version!==revision)dirty=true;
      }catch(e){if(!disposed){setError(String((e as Error).message));failure.current((e as Error).message);dirty=false;}}
      finally{busy=false;if(dirty&&!disposed)schedule();}
    }
    function fit(){const [l,b,r,t]=meta.bbox;fitHeight=Math.max(t-b,(r-l)*h/w)*1.1;cam={x:(l+r)/2,y:(b+t)/2,h:fitHeight};change();}
    function zoom(factor:number,x=w/2,y=h/2){const old=cam.h,next=Math.max(.01,Math.min(fitHeight*100,old*factor));cam.x+=(x/w-.5)*w/h*(old-next);cam.y+=(.5-y/h)*(old-next);cam.h=next;change();}
    const wheel=(event:WheelEvent)=>{event.preventDefault();const r=element.getBoundingClientRect();zoom(Math.exp(Math.max(-160,Math.min(160,event.deltaY))*.002),(event.clientX-r.left)*w/r.width,(event.clientY-r.top)*h/r.height);};
    const down=(event:PointerEvent)=>{if(event.button!==0)return;drag={x:event.clientX,y:event.clientY,cam:{...cam}};element.setPointerCapture(event.pointerId);};
    const move=(event:PointerEvent)=>{if(!drag)return;const size=element.getBoundingClientRect();cam.x=drag.cam.x-(event.clientX-drag.x)*drag.cam.h/size.height;cam.y=drag.cam.y+(event.clientY-drag.y)*drag.cam.h/size.height;change();};
    const up=()=>{drag=null;};
    const resize=new ResizeObserver(()=>{if(!element.clientWidth||!element.clientHeight)return;const ratio=Math.min(devicePixelRatio||1,1.5,3000/Math.max(64,element.clientWidth),3000/Math.max(64,element.clientHeight));surface.width=Math.max(64,Math.round(element.clientWidth*ratio));surface.height=Math.max(64,Math.round(element.clientHeight*ratio));w=surface.width;h=surface.height;if(!frame)fit();else change();});
    resize.observe(element);element.addEventListener('wheel',wheel,{passive:false});element.addEventListener('pointerdown',down);element.addEventListener('pointermove',move);element.addEventListener('pointerup',up);element.addEventListener('pointercancel',up);element.addEventListener('lostpointercapture',up);element.addEventListener('dblclick',fit);
    controls.current={zoom:f=>zoom(f),fit,layers:next=>{keys=next;change(true);},theme:name=>{themeName=name;change(true);}};
    return ()=>{disposed=true;clearTimeout(timer);clearTimeout(settle);resize.disconnect();frame?.image.close();element.removeEventListener('wheel',wheel);element.removeEventListener('pointerdown',down);element.removeEventListener('pointermove',move);element.removeEventListener('pointerup',up);element.removeEventListener('pointercancel',up);element.removeEventListener('lostpointercapture',up);element.removeEventListener('dblclick',fit);controls.current=undefined;};
  },[meta]);
  function toggle(key:string){const next=visible.includes(key)?visible.filter(k=>k!==key):[...visible,key];setVisible(next);controls.current?.layers(next);}
  return <div className="rp-layout"><div className="rp-view-tools"><button title="Zoom in" aria-label="Zoom in" onClick={()=>controls.current?.zoom(.8)}><Plus size={16}/></button><button title="Zoom out" aria-label="Zoom out" onClick={()=>controls.current?.zoom(1.25)}><Minus size={16}/></button><button title="Fit layout" aria-label="Fit layout" onClick={()=>controls.current?.fit()}><Maximize size={16}/></button><span className="rp-tool-caption">{meta.cell}</span><select aria-label="Layout theme" value={theme} onChange={e=>{setTheme(e.target.value);controls.current?.theme(e.target.value);}}><option value="01_neon">Neon</option><option value="02_blueprint">Blueprint</option><option value="03_ember">Ember</option><option value="04_routing">Routing</option></select><button className="rp-layers-button" onClick={()=>setLayerMenu(!layerMenu)} aria-expanded={layerMenu}><Layers size={15}/> Layers</button>{layerMenu?<div className="rp-layer-menu"><button onClick={()=>{const all=meta.layers.map(l=>l.key);setVisible(all);controls.current?.layers(all);}}>Show all</button>{meta.layers.map(layer=><label key={layer.key}><input type="checkbox" checked={visible.includes(layer.key)} onChange={()=>toggle(layer.key)}/>{layer.name}<button onClick={e=>{e.preventDefault();setVisible([layer.key]);controls.current?.layers([layer.key]);}}>Only</button></label>)}</div>:null}</div><div ref={host} className="rp-canvas-host"><canvas ref={canvas} aria-label={`KLayout rendering of ${meta.cell}`}/>{error?<div className="rp-view-error" role="alert">{error}</div>:null}</div><footer className="rp-view-footer"><span>KLayout {meta.klayout} · generic layer colors</span><span>{span}</span></footer></div>;
}
