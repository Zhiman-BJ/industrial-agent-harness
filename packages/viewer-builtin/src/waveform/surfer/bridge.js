// Adapter for the vendored official Surfer WASM build. No Node access.
import init, {inject_message,id_of_name,get_state,waves_loaded} from './surfer.js';
const requestedOrigin=new URLSearchParams(location.search).get('host_origin');
const origin=requestedOrigin && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(requestedOrigin) ? requestedOrigin : 'app://viewer';
const notify=data=>parent.postMessage({channel:'industrial-surfer',...data},origin);
window.on_surfer_error=message=>{
 document.getElementById('error_container').hidden=false;
 document.getElementById('error_message').textContent=message;
 notify({event:'error',message});
};
window.__surfer_host_api={postMessage:data=>notify({event:'surfer-event',data})};
try{
 await init({module_or_path:new URL('./surfer_bg.wasm',import.meta.url)});
 let wheelDelta = 0;
 document.addEventListener('wheel', event => {
  if(event.shiftKey || event.target?.tagName !== 'CANVAS')return;
  event.preventDefault(); event.stopImmediatePropagation();
  const pixels=event.deltaY*(event.deltaMode===1?8:event.deltaMode===2?24:1);
  if(Math.sign(pixels)!==Math.sign(wheelDelta))wheelDelta=0;
  wheelDelta+=Math.max(-120,Math.min(120,pixels));
  if(Math.abs(wheelDelta)<40)return;
  const command=wheelDelta<0?'zoom_in':'zoom_out';wheelDelta=0;
  inject_message(JSON.stringify({LoadCommandFromData:Array.from(new TextEncoder().encode(command))}));
 },{capture:true,passive:false});
 window.addEventListener('message',async event=>{
  if(event.source!==parent||event.origin!==origin||event.data?.channel!=='industrial-host')return;
  const {id,action,payload}=event.data;
  try{
   let result=true;
   if(action==='status'){notify({event:'ready'});if(await waves_loaded())notify({event:'loaded'});}
   else if(action==='presentation'){inject_message(JSON.stringify({SetSidePanelVisible:false}));inject_message(JSON.stringify({SetTimeUnit:'NanoSeconds'}));}
   else if(action==='commands')inject_message(JSON.stringify({LoadCommandFromData:Array.from(new TextEncoder().encode(payload))}));
   else if(action==='load'){await get_state();inject_message(JSON.stringify({LoadWaveformFileFromUrl:[payload,'Clear']}));}
   else if(action==='probe')result={loaded:await waves_loaded(),state:await get_state(),ids:await Promise.all((payload||[]).map(async name=>({name,id:await id_of_name(name)})))};
   else throw new Error('Unknown bridge action');
   notify({id,result});
  }catch(error){notify({id,error:String(error)});}
 });
 notify({event:'ready'});
 const loadedTimer=setInterval(async()=>{try{if(await waves_loaded()){clearInterval(loadedTimer);if(new URLSearchParams(location.search).get('embed_sample'))inject_message(JSON.stringify({SetTimeUnit:'NanoSeconds'}));notify({event:'loaded'});}}catch{}},150);
}catch(error){window.on_surfer_error(String(error));}
