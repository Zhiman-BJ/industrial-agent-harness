const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
async function run(window, evidence) {
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  async function wait(script) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {if (await evaluate(script)) return; await new Promise(resolve => setTimeout(resolve, 100));}
    throw Error(`Resource settings timed out: ${script}`);
  }
  async function openGlobal() {
    await evaluate(`document.querySelector('.ia-settings-button').click()`);
    await evaluate(`Array.from(document.querySelectorAll('.ia-settings-row')).find(row=>row.innerText.includes('MCP & Skills')).querySelector('button').click()`);
    await wait(`document.querySelectorAll('.ia-resource-modal input[type="checkbox"]').length===4`);
  }
  async function closeGlobal() {
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await wait(`!document.querySelector('.ia-resource-modal')`);
  }
  async function projectMode(mode) {
    await wait(`document.querySelector('.ia-project-resources select')&&!document.querySelector('.ia-project-resources select').disabled`);
    await evaluate(`(() => {const select=document.querySelector('.ia-project-resources select');select.value='${mode}';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(`document.querySelector('.ia-project-resources select').value==='${mode}'&&!document.querySelector('.ia-project-resources select').disabled`);
  }
  assert.equal(await evaluate(`document.querySelector('.ia-new-chat').closest('.ia-project-chats').dataset.projectId`), 'log-test', 'new chat belongs to the selected project');
  assert.equal(await evaluate(`document.querySelectorAll('.ia-sidebar > .ia-new-chat').length`), 0, 'no global new-chat action');
  await openGlobal();
  assert.ok(await evaluate(`document.querySelector('.ia-resource-modal').innerText.includes('No default domain MCP')`));
  await evaluate(`document.querySelector('.ia-resource-modal input').click()`);
  await wait(`window.viewerHost.resourceGet({projectId:'log-test'}).then(state=>state.effective.skills.includes('chip.netlist.inspect'))`);
  fs.writeFileSync(path.join(evidence,'global-resources.png'),(await window.webContents.capturePage()).toPNG());
  await closeGlobal();
  await evaluate(`document.querySelector('.ia-project-list button.selected').click()`);
  await wait(`document.querySelector('.ia-project-resources select')?.value==='inherit'`);
  await projectMode('enabled');
  assert.deepEqual(await evaluate(`window.viewerHost.resolve({task:'Inspect netlist'}).then(result=>result.scope.skills)`), ['chip.netlist.inspect']);
  assert.equal(await evaluate(`window.viewerHost.resourceSet({projectId:'other-test',kind:'skill',id:'chip.netlist.inspect',mode:'enabled'}).then(()=>false,()=>true)`), true, 'inactive project cannot mutate policy');
  assert.equal(await evaluate(`window.viewerHost.resourceSet({kind:'mcp',id:'unknown',mode:'enabled'}).then(()=>false,()=>true)`), true, 'unregistered MCP cannot be added');
  fs.writeFileSync(path.join(evidence,'project-resources.png'),(await window.webContents.capturePage()).toPNG());
  await evaluate(`Array.from(document.querySelectorAll('.ia-project-list button')).find(button=>button.innerText.includes('Other project')).click()`);
  await wait(`document.querySelector('.ia-project-page h1')?.innerText==='Other project'&&document.querySelector('.ia-project-resources select')?.value==='inherit'`);
  assert.deepEqual(await evaluate(`window.viewerHost.resolve({task:'Inspect netlist'}).then(result=>result.scope.skills)`), []);
  assert.equal(await evaluate(`document.querySelector('.ia-new-chat').closest('.ia-project-chats').dataset.projectId`), 'other-test');
  await evaluate(`Array.from(document.querySelectorAll('.ia-project-list button')).find(button=>button.innerText.includes('Agent log test')).click()`);
  await wait(`document.querySelector('.ia-project-page h1')?.innerText==='Agent log test'&&document.querySelector('.ia-project-resources select')?.value==='enabled'`);
  await projectMode('inherit');
  assert.deepEqual(await evaluate(`window.viewerHost.resolve({task:'Inspect netlist'}).then(result=>result.scope.skills)`), []);
  await openGlobal();
  await evaluate(`document.querySelector('.ia-resource-modal input').click()`);
  await wait(`window.viewerHost.resourceGet({}).then(state=>state.global.skills.length===0)`);
  await closeGlobal();
  // Returning from global settings remounts project controls to refresh inherited values.
  await wait(`document.querySelector('.ia-project-resources select')?.selectedOptions[0].text.includes('enabled')`);
  await projectMode('disabled');
  assert.deepEqual(await evaluate(`window.viewerHost.resolve({task:'Inspect netlist'}).then(result=>result.scope.skills)`), []);
  await projectMode('inherit');
  await evaluate(`document.querySelector('.ia-project-start').click()`);
  await wait(`Boolean(document.querySelector('.ia-composer textarea'))`);
}
module.exports = {run};
