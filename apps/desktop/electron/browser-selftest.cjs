const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { saveBindings } = require('./project-bindings.cjs');

// The embedded browser is exercised without external network: the guest loads
// a data: URL page, and the assertions cover tab creation, navigation,
// history, popup redirection into the same frame, and guest isolation from
// the privileged host renderer.
let directory;
function prepare(config) {
  directory = path.join(config, 'browser-project');
  fs.mkdirSync(directory, { recursive: true });
  saveBindings(config, {
    activeId: 'browser-project',
    projects: [
      {
        id: 'browser-project',
        name: 'Browser selftest',
        path: fs.realpathSync(directory),
        domain: 'chip',
      },
    ],
  });
}
async function run(window) {
  const evaluate = async script => {
    try {
      return await window.webContents.executeJavaScript(script, true);
    } catch (error) {
      throw Error(`${error.message}\nScript: ${script}`);
    }
  };
  async function wait(script) {
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error(`Browser selftest timed out: ${script}`);
  }
  try {
    await wait(`document.querySelector('.ia-domain-pill')?.innerText.includes('Chip')`);
    await evaluate(`document.querySelector('.ia-chat-actions button:last-child').click()`);
    await wait(`Boolean(document.querySelector('.ia-workspace-actions button'))`);
    await evaluate(
      `document.querySelector('button[aria-label="Open browser"], button[aria-label="打开浏览器"]').click()`,
    );
    await wait(`Boolean(document.querySelector('.ia-browser webview'))`);
    // Repeat clicks reuse the single browser tab instead of piling up.
    await evaluate(
      `document.querySelector('button[aria-label="Open browser"], button[aria-label="打开浏览器"]').click()`,
    );
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await evaluate(`document.querySelectorAll('.ia-browser webview').length`), 1);
    const page =
      'data:text/html,<title>probe-page</title><h1>browser probe</h1>' +
      '<script>globalThis.hostMarker = undefined</' +
      'script>';
    await evaluate(
      `document.querySelector('.ia-browser webview').loadURL(${JSON.stringify(page)})`,
    );
    await wait(
      `(() => {const w=document.querySelector('.ia-browser webview'); try{return w.getTitle()==='probe-page'}catch{return false}})()`,
    );
    // The guest is a separate process: no preload, no host bridge, no Node.
    assert.equal(
      await evaluate(
        `document.querySelector('.ia-browser webview').executeJavaScript("typeof window.viewerHost + '|' + typeof process")`,
      ),
      'undefined|undefined',
    );
    // Address bar search terms route to the default search engine.
    await evaluate(
      `(() => {const input=document.querySelector('.ia-browser-bar input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'harness probe search'); input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('.ia-browser-bar button[type="submit"]').click();})()`,
    );
    await wait(
      `(() => {const w=document.querySelector('.ia-browser webview'); try{return w.getURL().startsWith('https://www.baidu.com/s?wd=')}catch{return false}})()`,
    );
    // Popups (target=_blank / window.open) never spawn native windows; the URL
    // is redirected into the same guest frame.
    await evaluate(
      `document.querySelector('.ia-browser webview').executeJavaScript("window.open('https://example.com/popup-target')")`,
    );
    await wait(
      `(() => {const w=document.querySelector('.ia-browser webview'); try{return w.getURL().includes('example.com/popup-target')}catch{return false}})()`,
    );
    assert.equal(await evaluate(`document.querySelectorAll('.ia-browser webview').length`), 1);
    // History navigation drives the Back/Forward controls.
    await evaluate(
      `document.querySelector('.ia-browser-bar button[aria-label="Back"], .ia-browser-bar button[aria-label="后退"]').click()`,
    );
    await wait(
      `(() => {const w=document.querySelector('.ia-browser webview'); try{return w.getURL().startsWith('https://www.baidu.com/s')}catch{return false}})()`,
    );
    await evaluate(
      `document.querySelector('.ia-browser-bar button[aria-label="Forward"], .ia-browser-bar button[aria-label="前进"]').click()`,
    );
    await wait(
      `(() => {const w=document.querySelector('.ia-browser webview'); try{return w.getURL().includes('example.com')}catch{return false}})()`,
    );
    console.log(
      JSON.stringify({
        ok: true,
        singleTab: true,
        guestIsolated: true,
        searchRouting: true,
        popupRedirect: true,
        history: true,
      }),
    );
  } catch (error) {
    fs.writeFileSync(
      path.join(directory, 'failure.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    console.error('Browser selftest project:', directory);
    throw error;
  }
}
module.exports = { prepare, run };
