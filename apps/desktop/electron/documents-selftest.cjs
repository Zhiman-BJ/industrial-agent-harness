const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { saveBindings } = require('./project-bindings.cjs');
const {
  verifyNavigation,
  verifyWheelScroll,
  transitionFullscreen,
} = require('./navigation-selftest.cjs');
let directory;
let originals;
function prepare(config) {
  directory = path.join(config, 'documents-project');
  fs.mkdirSync(directory, { recursive: true });
  originals = {
    'data.csv':
      'name,id,note\r\n中文,000001,"hello, world\nsecond line"\r\n' +
      Array.from({ length: 225 }, (_, i) => `item${i},${i},row ${i}`).join('\r\n'),
    'data.tsv': 'name\tvalue\n中文\t00123\nsecond\t=1+2\n',
    'settings.json':
      '{"modules":{"plugin":{"enabled":true}},"nested":{"answer":42},"literal":"<img src=x onerror=globalThis.documentAttack=true>"}',
    'array.json': JSON.stringify(Array.from({ length: 125 }, (_, i) => `value-${i}`)),
    'large-number.json': '{"id":9007199254740993}',
    'events.jsonl': Array.from({ length: 45 }, (_, i) =>
      JSON.stringify({ index: i, result: { ok: true } }),
    ).join('\n'),
    'events.ndjson': '{"index":0}\n{"index":1}\n',
    'README.md':
      '\uFEFF# Document preview\n\n**Bold text** and `code`.\n\n| Name | Value |\n| --- | --- |\n| 中文 | 42 |\n\n- [x] task\n\n[External](https://example.com/escape)\n![Remote](https://example.com/image.png)\n\n<script>globalThis.documentAttack=true</script>\n\n<iframe src="https://example.com/frame"></iframe>\n',
    'deep.md': '>'.repeat(80) + ' Excessively nested Markdown',
    'run.log':
      'Starting job\n' +
      Array.from(
        { length: 450 },
        (_, i) => `Line ${i}: ${i === 321 ? 'UNIQUE_RESULT' : 'running'}`,
      ).join('\n'),
    'notes.txt': 'plain text\n中文\n',
    'invalid.json': '{"value":broken}',
    'invalid.csv': 'a,b\n1,"unclosed',
    'invalid.jsonl': '{}\n{bad}\n',
    'oversized.txt': 'x'.repeat(4 * 1024 * 1024 + 1),
    'sheet.sprite.json': '{"version":1,"image":"pixel.png","columns":1,"rows":1}',
  };
  for (const [file, text] of Object.entries(originals))
    fs.writeFileSync(path.join(directory, file), text);
  fs.writeFileSync(
    path.join(directory, 'pixel.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  fs.copyFileSync(
    path.resolve(__dirname, '../../../packages/viewer-builtin/fixtures/counter.json'),
    path.join(directory, 'counter.json'),
  );
  const other = path.join(config, 'other-documents-project');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'settings.json'), '{"project":"other"}');
  saveBindings(config, {
    activeId: 'documents-pcb',
    projects: [
      {
        id: 'documents-pcb',
        name: 'Documents PCB',
        path: fs.realpathSync(directory),
        domain: 'pcb',
      },
      {
        id: 'documents-chip',
        name: 'Documents Chip',
        path: fs.realpathSync(other),
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
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error(`Document Viewer condition timed out: ${script}`);
  }
  const click = label =>
    evaluate(
      `Array.from(document.querySelector('.ia-file-view:not([hidden])').querySelectorAll('.rp-document button')).find(button => button.textContent === ${JSON.stringify(label)}).click()`,
    );
  const find = query =>
    evaluate(
      `(() => {const input=document.querySelector('.ia-file-view:not([hidden])').querySelector('input[aria-label="Find in document"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(query)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
  async function open(file, kind) {
    await evaluate(
      `document.querySelector('.ia-file-list button[title=${JSON.stringify(file)}]').click()`,
    );
    await wait(
      `document.querySelector('.ia-viewer-header b')?.textContent === ${JSON.stringify(file)} && document.querySelector('.ia-viewer-footer')?.innerText.includes('${kind.toUpperCase()} · Ready')`,
    );
  }
  const requests = [];
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    if (/^https?:/.test(details.url)) requests.push(details.url);
    callback({ cancel: /^https?:/.test(details.url) });
  });
  try {
    await wait(`document.querySelector('.ia-domain-pill')?.innerText.includes('PCB')`);
    await evaluate(`document.querySelector('.ia-chat-actions button:last-child').click()`);
    await wait(`Boolean(document.querySelector('.ia-workspace-actions button'))`);
    await evaluate(`document.querySelector('.ia-file-tree-toggle').click()`);
    const screenshots = [];
    for (const [file, kind, selector] of [
      ['data.csv', 'table', '.rp-document-table th'],
      ['settings.json', 'json', '.rp-json-toggle'],
      ['events.jsonl', 'jsonl', '.rp-json-toggle'],
      ['README.md', 'markdown', '.rp-document-markdown h1'],
      ['run.log', 'text', '.rp-document-line'],
    ]) {
      await open(file, kind);
      const measure = () =>
        evaluate(`document.querySelector('${selector}').getBoundingClientRect().height`);
      await verifyNavigation(window, measure);
      await verifyWheelScroll(window, measure, (delta, ctrl) =>
        evaluate(
          `(() => {const element=document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-viewport'); const event=new WheelEvent('wheel',{deltaY:${delta},ctrlKey:${ctrl},cancelable:true}); element.dispatchEvent(event); return event.defaultPrevented;})()`,
        ),
      );
      const screenshot = path.join(directory, `${kind}.png`);
      fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
      screenshots.push(screenshot);
    }
    await open('data.csv', 'table');
    assert.equal(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])').querySelectorAll('.rp-document-table tbody tr').length`,
      ),
      100,
    );
    assert.ok(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-table tbody').textContent.includes(${JSON.stringify('hello, world\nsecond line')})`,
      ),
    );
    await click('Next');
    await wait(
      `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-pages').textContent.includes('Page 2')`,
    );
    await find('item224');
    await wait(
      `document.querySelector('.ia-file-view:not([hidden])').querySelectorAll('.rp-document-table tbody tr').length === 1`,
    );
    assert.ok(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-pages').textContent.includes('Page 1')`,
      ),
    );
    await click('Source');
    await wait(
      `Boolean(document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-text'))`,
    );
    await open('data.tsv', 'table');
    assert.ok(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-table').textContent.includes('00123') && document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-table').textContent.includes('=1+2')`,
      ),
    );
    await evaluate(
      `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-options input[type="checkbox"]').click()`,
    );
    await wait(
      `document.querySelector('.ia-file-view:not([hidden])').querySelectorAll('.rp-document-table tbody tr').length === 3`,
    );
    assert.ok(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-table thead').textContent.includes('Column 1')`,
      ),
    );
    await open('array.json', 'json');
    assert.equal(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])').querySelectorAll('.rp-json-leaf').length`,
      ),
      50,
    );
    await click('Next');
    await wait(
      `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-json').textContent.includes('value-50')`,
    );
    assert.ok(
      !(await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-json').textContent.includes('"value-0"')`,
      )),
    );
    await open('large-number.json', 'json');
    assert.ok(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-text').textContent.includes('9007199254740993') && Boolean(document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-notice[role="status"]'))`,
      ),
    );
    await open('settings.json', 'json');
    await evaluate(
      `Array.from(document.querySelector('.ia-file-view:not([hidden])').querySelectorAll('.rp-json-toggle')).find(button => button.querySelector('b')?.textContent === 'nested').click()`,
    );
    await wait(
      `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-json').textContent.includes('answer')`,
    );
    await evaluate(`document.querySelector('button[aria-label="Zoom in"]').click()`);
    await transitionFullscreen(window, true, () =>
      evaluate(`document.querySelector('button[aria-label="Fullscreen viewer"]').click()`),
    );
    assert.equal(
      await evaluate(`document.querySelector('output[aria-label="Viewer zoom"]').textContent`),
      '120%',
    );
    assert.ok(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-json').textContent.includes('answer')`,
      ),
    );
    await transitionFullscreen(window, false, () => {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    });
    assert.ok(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-json').textContent.includes('answer')`,
      ),
    );
    assert.equal(
      await evaluate(`document.querySelector('output[aria-label="Viewer zoom"]').textContent`),
      '120%',
    );
    await open('events.jsonl', 'jsonl');
    await click('Next');
    await wait(
      `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-json').textContent.includes('Line 21')`,
    );
    await open('events.ndjson', 'jsonl');
    assert.ok(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-json').textContent.includes('2 records')`,
      ),
    );
    await open('README.md', 'markdown');
    assert.equal(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-markdown h1').textContent`,
      ),
      'Document preview',
    );
    assert.equal(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])').querySelectorAll('.rp-document-markdown table tbody tr').length`,
      ),
      1,
    );
    assert.equal(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])').querySelectorAll('.rp-document-markdown img,.rp-document-markdown iframe,.rp-document-markdown script,.rp-document-markdown a[href]').length`,
      ),
      0,
    );
    assert.equal(await evaluate(`Boolean(globalThis.documentAttack)`), false);
    await click('Source');
    assert.ok(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-text').textContent.includes('<script>')`,
      ),
    );
    await open('deep.md', 'markdown');
    assert.ok(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-notice[role="alert"]').textContent.includes('node/depth limit') && Boolean(document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-text'))`,
      ),
    );
    await open('run.log', 'text');
    await click('Next');
    await wait(
      `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-pages').textContent.includes('Page 2')`,
    );
    await find('UNIQUE_RESULT');
    await wait(
      `document.querySelector('.ia-file-view:not([hidden])').querySelectorAll('.rp-document-line').length === 1`,
    );
    assert.ok(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-pages').textContent.includes('Page 1') && document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-line-number').textContent === '323'`,
      ),
    );
    await evaluate(
      `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-options input[type="checkbox"]').click()`,
    );
    assert.equal(
      await evaluate(
        `getComputedStyle(document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-text pre')).whiteSpace`,
      ),
      'pre',
    );
    await open('notes.txt', 'text');
    assert.ok(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-text').textContent.includes('中文')`,
      ),
    );
    for (const [file, kind] of [
      ['invalid.csv', 'table'],
      ['invalid.json', 'json'],
      ['invalid.jsonl', 'jsonl'],
    ]) {
      await open(file, kind);
      assert.ok(
        await evaluate(
          `Boolean(document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document [role="alert"]') && document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-text'))`,
        ),
      );
    }
    await evaluate(`document.querySelector('.ia-file-list button[title="oversized.txt"]').click()`);
    await wait(`document.body.innerText.includes('exceeds the 4 MiB Viewer limit')`);
    assert.ok(
      !(await evaluate(`document.querySelector('.ia-viewer-footer')?.innerText.includes('Ready')`)),
    );
    assert.equal(
      await evaluate(`window.viewerHost.readProjectFile('counter.json').then(file=>file.viewer)`),
      'netlist',
    );
    assert.equal(
      await evaluate(
        `window.viewerHost.readProjectFile('sheet.sprite.json').then(file=>file.viewer)`,
      ),
      'sprite',
    );
    for (const [file, text] of Object.entries(originals))
      assert.equal(
        fs.readFileSync(path.join(directory, file), 'utf8'),
        text,
        'viewing did not modify sources',
      );
    const selected = await evaluate(`window.viewerHost.openProjectFile('settings.json')`);
    fs.writeFileSync(path.join(directory, 'settings.json'), '{"changed":true}');
    assert.ok(
      await evaluate(
        `window.viewerHost.open({artifactId:${JSON.stringify(selected.id)}}).then(()=>false,error=>/changed/.test(String(error)))`,
      ),
    );
    // Change through the production project selector and ensure stale artifacts are rejected.
    await evaluate(
      `Array.from(document.querySelectorAll('button.ia-project-row')).find(button=>button.textContent.includes('Documents Chip')).click()`,
    );
    await wait(
      `document.querySelector('.ia-project-row.selected')?.textContent.includes('Documents Chip') && document.querySelector('.ia-new-chat')?.disabled === false`,
    );
    await evaluate(`document.querySelector('.ia-new-chat').click()`);
    await wait(`document.querySelector('.ia-domain-pill')?.textContent.includes('Chip')`);
    await evaluate(`document.querySelector('.ia-chat-actions button:last-child').click()`);
    await wait(`Boolean(document.querySelector('.ia-file-tree-toggle'))`);
    await evaluate(`document.querySelector('.ia-file-tree-toggle').click()`);
    await open('settings.json', 'json');
    assert.ok(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-document-json').textContent.includes('other')`,
      ),
    );
    assert.equal(
      await evaluate(`window.viewerHost.readProjectFile('settings.json').then(file=>file.viewer)`),
      'json',
    );
    assert.ok(
      await evaluate(
        `window.viewerHost.open({artifactId:${JSON.stringify(selected.id)}}).then(()=>false,error=>/Unknown artifact/.test(String(error)))`,
      ),
    );
    assert.deepEqual(requests, [], 'document preview makes no external requests');
    console.log(
      JSON.stringify({
        ok: true,
        viewers: 5,
        formats: 8,
        navigation: true,
        fullscreenState: true,
        malformedSource: true,
        specializedPriority: true,
        projectIsolation: true,
        externalRequests: requests.length,
        screenshots,
      }),
    );
  } catch (error) {
    fs.writeFileSync(
      path.join(directory, 'failure.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    console.error('Document selftest project:', directory);
    throw error;
  } finally {
    window.webContents.session.webRequest.onBeforeRequest(null);
  }
}
module.exports = { prepare, run };
