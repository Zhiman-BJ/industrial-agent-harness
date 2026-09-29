const {Worker}=require('node:worker_threads');
const path=require('node:path');
const fs=require('node:fs');
function isYosysNetlist(file) {
  if(path.extname(file).toLowerCase()!=='.json'||fs.statSync(file).size>20*1024*1024)return false;
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  try {
    const data=JSON.parse(fs.readFileSync(file,'utf8'));
    return object(data?.modules)&&Object.values(data.modules).some(module=>object(module)&&object(module.ports)&&object(module.cells)&&object(module.netnames));
  }catch{return false;}
}
function renderNetlist(file,module,focus) {
  return new Promise((resolve,reject)=>{
    const thread=new Worker(path.join(__dirname,'netlist-worker.cjs'),{workerData:{file,module,focus}});
    let settled=false;
    const finish=(error,data)=>{if(settled)return;settled=true;clearTimeout(timer);void thread.terminate();error?reject(error):resolve(data);};
    const timer=setTimeout(()=>finish(Error('Netlist layout exceeded 60 seconds.')),60000);
    thread.once('message',data=>finish(data.error?Error(data.error):null,data));
    thread.once('error',error=>finish(error));
    thread.once('exit',code=>{if(!settled)finish(Error(`Netlist worker stopped (${code}).`));});
  });
}
module.exports={renderNetlist,isYosysNetlist};
