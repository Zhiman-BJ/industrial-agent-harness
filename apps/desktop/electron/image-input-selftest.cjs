const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {nativeImage} = require('electron');
const {saveBindings} = require('./project-bindings.cjs');
const {saveProfile} = require('./model-config.cjs');
let evidence;
const prompts = [];
const crypto = require('node:crypto');
function prepare(config, models) {
  evidence = path.dirname(config);
  const projects = ['images', 'other'].map(id => {const folder = path.join(config, id); fs.mkdirSync(folder, {recursive: true}); return {id, name: id === 'images' ? 'Image input test' : 'Other project', path: folder, domain: 'chip'};});
  saveBindings(config, {activeId: 'images', projects});
  saveProfile(models, {provider: 'openai_legacy', endpoint: 'http://127.0.0.1:1/v1', model: 'test-vision', contextSize: 32768, thinking: false, imageInputMode: 'disabled'});
}
function createSession(options) {
  assert.match(fs.readFileSync(path.join(options.shareDir, 'config.toml'), 'utf8'), /"image_in"/);
  const directory = path.join(options.shareDir, 'sessions', crypto.createHash('md5').update(options.workDir).digest('hex'), options.sessionId);
  fs.mkdirSync(directory, {recursive: true});
  fs.appendFileSync(path.join(directory, 'context.jsonl'), '{}\n');
  return {sessionId: options.sessionId, close: async () => {}, prompt(content) {
    prompts.push(content);
    return {result: Promise.resolve({status: 'completed'}), cancel: async () => {}, async *[Symbol.asyncIterator]() {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (prompts.length === 1) throw Error('Provider rejected image input: retry test');
      yield {type: 'ContentPart', payload: {type: 'text', text: 'Image input received.'}};
    }};
  }};
}
async function run(window) {
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  async function wait(script) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {if (await evaluate(script)) return; await new Promise(resolve => setTimeout(resolve, 100));}
    throw Error(`Image UI timed out: ${script}`);
  }
  const bitmap = Buffer.alloc(24 * 16 * 4, 255);
  const raster = nativeImage.createFromBitmap(bitmap, {width: 24, height: 16});
  const fixtures = [
    {name: 'chosen.png', mime: 'image/png', base64: raster.toPNG().toString('base64')},
    {name: 'pasted.jpg', mime: 'image/jpeg', base64: raster.toJPEG(85).toString('base64')},
    {name: 'dropped.webp', mime: 'image/webp', base64: 'UklGRkgAAABXRUJQVlA4IDwAAAAwAwCdASoYABAAPm0skUWkIqGYBABABsSgC7LoB+AACEUAAP7wm0P/kFywuuRr/8gP+QH/ID/+PguzAAA='},
  ];
  async function attach(index, method) {
    await evaluate(`(() => {
      const fixture=${JSON.stringify(fixtures[index])};
      const file=new File([Uint8Array.from(atob(fixture.base64),c=>c.charCodeAt(0))],fixture.name,{type:fixture.mime});
      const data=new DataTransfer();data.items.add(file);
      if ('${method}'==='choose') {const input=document.querySelector('input[aria-label="Image attachment files"]');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));}
      else if ('${method}'==='paste') document.querySelector('.ia-composer textarea').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:data}));
      else document.querySelector('.ia-composer').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data}));
    })()`);
    await wait(`document.querySelectorAll('.ia-composer .ia-image-attachments img').length===${index + 1}&&!document.querySelector('.ia-composer p[role="status"]')`);
  }
  const requests = [];
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {if (/^https?:/.test(details.url)) requests.push(details.url); callback({cancel: /^https?:/.test(details.url)});});
  try {
    await wait(`document.querySelector('.ia-chat-header b')?.innerText==='Image input test'`);
    assert.equal(await evaluate(`window.viewerHost.validateImages({projectId:'other',images:[]}).then(()=>false,()=>true)`), true);
    await attach(0, 'choose'); await attach(1, 'paste'); await attach(2, 'drop');
    assert.equal(await evaluate(`document.querySelector('.ia-send').disabled`), true, 'text model blocks image sends');
    assert.equal(prompts.length, 0);
    await evaluate(`document.querySelector('.ia-image-model-hint button').click()`);
    await wait(`document.querySelector('select[aria-label="Model image input"]')?.value==='disabled'`);
    await evaluate(`(() => {const input=document.querySelector('select[aria-label="Model image input"]');input.value='enabled';input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await evaluate(`Array.from(document.querySelectorAll('.ia-model-modal footer button')).find(button=>button.innerText==='Save').click()`);
    await wait(`document.querySelector('.ia-model-success')?.innerText.includes('saved')&&!document.querySelector('.ia-send').disabled`);
    await evaluate(`document.querySelector('button[aria-label="Close settings"]').click()`);
    fs.writeFileSync(path.join(evidence, 'image-input-preview.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate(`document.querySelector('.ia-send').click()`);
    await wait(`document.querySelector('.ia-agent-flow')?.innerText.includes('Provider rejected image input')&&document.querySelectorAll('.ia-composer .ia-image-attachments img').length===3&&!document.querySelector('.ia-send').disabled`);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0][0].text, /Describe the attached images/);
    await evaluate(`document.querySelector('.ia-send').click()`);
    await wait(`document.querySelector('.ia-chat-scroll')?.innerText.includes('Image input received')&&!document.querySelector('button[title="Stop agent"]')`);
    assert.equal(prompts.length, 2);
    assert.deepEqual(prompts[1], prompts[0], 'provider failure keeps the exact image request for retry');
    assert.deepEqual(prompts[1].slice(1).map(part => part.image_url.url), fixtures.map(fixture => `data:${fixture.mime};base64,${fixture.base64}`));
    assert.equal(await evaluate(`document.querySelectorAll('.ia-composer .ia-image-attachments img').length`), 0);
    assert.equal(await evaluate(`document.querySelectorAll('.ia-chat-turn:last-of-type .ia-user-message .ia-image-attachments img').length`), 3);
    await window.webContents.reload();
    await wait(`document.querySelectorAll('.ia-user-message .ia-image-attachments img').length===6`);
    fs.writeFileSync(path.join(evidence, 'image-input-sent.png'), (await window.webContents.capturePage()).toPNG());
    const bad = {id: 'bad', name: 'invalid.png', dataUrl: 'data:image/png;base64,' + Buffer.from('not a PNG').toString('base64')};
    assert.equal(await evaluate(`window.viewerHost.validateImages({projectId:'images',images:[${JSON.stringify(bad)}]}).then(()=>false,()=>true)`), true);
    await attach(0, 'choose');
    await evaluate(`document.querySelector('.ia-composer button[aria-label="Remove image chosen.png"]').click()`);
    await wait(`!document.querySelector('.ia-composer .ia-image-attachments img')`);
    await attach(0, 'paste');
    await evaluate(`document.querySelector('.ia-new-chat').click()`);
    await wait(`!document.querySelector('.ia-composer .ia-image-attachments img')&&!document.querySelector('.ia-user-message')`);
    await attach(0, 'drop');
    await evaluate(`Array.from(document.querySelectorAll('.ia-project-list button')).find(button=>button.innerText.includes('Other project')).click()`);
    await wait(`document.querySelector('.ia-project-page h1')?.innerText==='Other project'`);
    await evaluate(`document.querySelector('.ia-project-start').click()`);
    await wait(`document.querySelector('.ia-composer textarea')&&!document.querySelector('.ia-composer .ia-image-attachments img')`);
    assert.equal(requests.length, 0);
    console.log(JSON.stringify({ok: true, filePicker: true, paste: true, drop: true, png: true, jpeg: true, webp: true, modelCompatibility: true, providerFailureRetry: true, projectIsolation: true, newChatReset: true, externalRequests: 0, evidence}));
  } catch (error) {fs.writeFileSync(path.join(evidence, 'image-input-failure.png'), (await window.webContents.capturePage()).toPNG()); console.error('Image input UI evidence:', evidence); throw error;}
  finally {window.webContents.session.webRequest.onBeforeRequest(null);}
}
module.exports = {prepare, createSession, run};
