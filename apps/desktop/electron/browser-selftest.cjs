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
    await evaluate(`document.querySelector('[data-testid="workspace-toggle"]').click()`);
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
    // Workbench browser automation: the plugin driver finds the open tab and
    // drives it — the same calls the agent's web_* tools make end to end.
    const { createWorkbenchBrowserPlugin } = require('./browser-driver.cjs');
    const automation = Object.fromEntries(
      createWorkbenchBrowserPlugin({ enabled: () => true, getWindow: () => window })
        .toolsFactory()
        .map(tool => [tool.name, tool]),
    );
    // Close the tab first: navigating with no browser open must re-open it
    // through the browser:open request, so the agent can pull up the browser
    // itself instead of asking the user to click the globe icon.
    await evaluate(
      `document.querySelector('button[aria-label="Close file"], button[aria-label="关闭文件"]').click()`,
    );
    await wait(`!document.querySelector('.ia-browser webview')`);
    const probe =
      'data:text/html,<title>auto-probe</title><h1>automation probe</h1>' +
      '<a href="https://example.com/target">go target</a>' +
      '<input id="q" placeholder="query">';
    const navigated = await automation.web_navigate.handler({ url: probe });
    assert.match(navigated.output, /auto-probe/);
    const snapshot = await automation.web_snapshot.handler({});
    assert.match(snapshot.output, /automation probe/);
    assert.match(snapshot.output, /e1 <a> "go target"/);
    assert.match(snapshot.output, /e2 <input>/);
    // A disabled plugin denies the same call without touching the page.
    const disabled = Object.fromEntries(
      createWorkbenchBrowserPlugin({ enabled: () => false, getWindow: () => window })
        .toolsFactory()
        .map(tool => [tool.name, tool]),
    );
    assert.match((await disabled.web_snapshot.handler({})).output, /^\[denied\]/);
    // Click by ref follows the link.
    const clicked = await automation.web_click.handler({ ref: 'e1' });
    await wait(
      `(() => {const w=document.querySelector('.ia-browser webview'); try{return w.getURL().includes('example.com/target')}catch{return false}})()`,
    );
    assert.match(clicked.output, /^Clicked e1/);
    // Back returns to the probe page; refs are re-read after navigation.
    await automation.web_back.handler({});
    await wait(
      `(() => {const w=document.querySelector('.ia-browser webview'); try{return w.getTitle()==='auto-probe'}catch{return false}})()`,
    );
    const resnap = await automation.web_snapshot.handler({});
    assert.match(resnap.output, /e2 <input>/);
    // Typing focuses the input and inserts real text; the value shows up in
    // the next snapshot's label.
    const typed = await automation.web_type.handler({ ref: 'e2', text: 'harness probe' });
    assert.match(typed.output, /^Typed /);
    const afterType = await automation.web_snapshot.handler({});
    assert.match(afterType.output, /harness probe/);
    // Scroll, wait and screenshot round out the surface.
    assert.match((await automation.web_scroll.handler({})).output, /^Scrolled down/);
    assert.match((await automation.web_wait.handler({ seconds: 0.1 })).output, /^Waited/);
    const shot = await automation.web_screenshot.handler({});
    assert.ok(Array.isArray(shot.output));
    assert.equal(shot.output[1].type, 'image_url');
    assert.ok(shot.output[1].image_url.url.startsWith('data:image/png;base64,'));
    console.log(
      JSON.stringify({
        ok: true,
        singleTab: true,
        guestIsolated: true,
        searchRouting: true,
        popupRedirect: true,
        history: true,
        automation: true,
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
