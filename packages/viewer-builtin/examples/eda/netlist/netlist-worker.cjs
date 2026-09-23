const {parentPort,workerData}=require('node:worker_threads');
const fs=require('node:fs');
const path=require('node:path');
const netlistsvg=require('netlistsvg');
(async()=>{
 const started=performance.now();
 const size=fs.statSync(workerData.file).size;
 if(size>20*1024*1024)throw new Error('此 demo 最多打开 20 MB 的网表 JSON');
 const data=JSON.parse(fs.readFileSync(workerData.file,'utf8'));
 const modules=Object.keys(data.modules||{});
 const top=workerData.module||modules.find(k=>Number(data.modules[k].attributes?.top)===1)||modules[0];
 if(!top||!data.modules[top])throw new Error('JSON 中没有可渲染的 modules');
 let module=data.modules[top];
 const totalCells=Object.keys(module.cells||{}).length;
 const allNets=Object.entries(module.netnames||{}).filter(([name,net])=>!net.hide_name&&!name.startsWith('$')).map(([name,net])=>({name,bits:net.bits}));
 let focus=null;
 if(totalCells>3000){
   focus=workerData.focus||Object.keys(module.ports||{}).find(name=>module.ports[name].direction==='output')||allNets[0]?.name;
   const bits=module.netnames?.[focus]?.bits||module.ports?.[focus]?.bits;
   if(!bits)throw Error('Selected net is not present in this module.');
   const entries=Object.entries(module.cells||{}),byBit=new Map();
   for(const [name,cell] of entries)for(const bit of new Set(Object.values(cell.connections||{}).flat())){if(typeof bit!=='number')continue;if(!byBit.has(bit))byBit.set(bit,[]);byBit.get(bit).push(name);}
   const selected=new Set(),visited=new Set();let frontier=[...bits];
   // Bounded real connectivity neighborhood. Omitted cells are explicitly labeled in the UI.
   for(let depth=0;depth<3&&selected.size<100;depth++){
     const next=[];
     for(const bit of frontier){if(visited.has(bit))continue;visited.add(bit);
       for(const name of byBit.get(bit)||[]){if(selected.has(name))continue;if(selected.size>=100)break;selected.add(name);
         for(const wire of Object.values(module.cells[name].connections||{}).flat())if((byBit.get(wire)?.length||0)<256)next.push(wire);
       }
     }frontier=next;
   }
   const cells=Object.fromEntries(entries.filter(([name])=>selected.has(name)));
   const used=new Set(Object.values(cells).flatMap(cell=>Object.values(cell.connections||{}).flat()));
   const ports=Object.fromEntries(Object.entries(module.ports||{}).filter(([,port])=>port.bits.some(bit=>used.has(bit))));
   module={...module,cells,ports};
 }

 let skin=fs.readFileSync(path.join(path.dirname(require.resolve('netlistsvg')),'../lib/default.svg'),'utf8');
 skin=skin.replaceAll('stroke:#000','stroke:#8db6c9').replaceAll('fill:#000','fill:#c8dce8');
 const svg=await netlistsvg.render(skin,{...data,modules:{[top]:module}});
 if(!svg?.includes('<svg'))throw new Error('netlistsvg 未返回有效 SVG');
 parentPort.postMessage({svg,top,modules,cellCount:Object.keys(module.cells||{}).length,
  nets:allNets,totalCells,partial:totalCells>3000,focus,
  cells:Object.entries(module.cells||{}).map(([name,cell])=>({name,type:cell.type})),
  elapsed_ms:Math.round(performance.now()-started)});
})().catch(error=>parentPort.postMessage({error:String(error.message||error)}));
