const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { saveBindings } = require('./project-bindings.cjs');
const { verifyNavigation, verifyWheelScroll } = require('./navigation-selftest.cjs');
let godot, pcb;
function prepare(config) {
  godot = path.join(config, 'engineering-godot');
  pcb = path.join(config, 'engineering-pcb');
  fs.mkdirSync(godot, { recursive: true });
  fs.mkdirSync(pcb, { recursive: true });
  for (const name of ['project.godot', 'playground.tscn', 'playground.gd', 'robot.png'])
    fs.copyFileSync(
      path.resolve(__dirname, '../../../examples/godot-viewer', name),
      path.join(godot, name),
    );
  fs.writeFileSync(
    path.join(godot, 'theme.tres'),
    '[gd_resource type="Theme" format=3]\n[resource]\ndefault_font_size = 20\n',
  );
  fs.writeFileSync(path.join(godot, 'theme.res'), Buffer.from('RSRC12345678'));
  fs.writeFileSync(
    path.join(godot, 'sound.wav'),
    Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WAVEfmt '),
      Buffer.alloc(40),
    ]),
  );
  fs.writeFileSync(path.join(godot, 'mesh.obj'), 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  fs.writeFileSync(
    path.join(godot, 'model.gltf'),
    JSON.stringify({ asset: { version: '2.0' }, nodes: [{ name: 'Body', mesh: 0 }], meshes: [{}] }),
  );
  const json = Buffer.from(
    JSON.stringify({ asset: { version: '2.0' }, nodes: [{ name: 'Head' }] }),
  );
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 32)]);
  const header = Buffer.alloc(20);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + padded.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.write('JSON', 16);
  fs.writeFileSync(path.join(godot, 'model.glb'), Buffer.concat([header, padded]));
  fs.writeFileSync(
    path.join(pcb, 'Device.kicad_sym'),
    '(kicad_symbol_lib (version 20211014) (symbol "R" (property "Reference" "R") (symbol "R_1_1" (rectangle (start -1 1) (end 1 -1)) (pin passive line (at -3 0 0) (length 2) (name "A") (number "1")))) (symbol "C" (property "Reference" "C") (symbol "C_1_1" (rectangle (start -2 2) (end 2 -2)))))',
  );
  fs.mkdirSync(path.join(pcb, 'Resistor.pretty'));
  fs.writeFileSync(
    path.join(pcb, 'Resistor.pretty/R_0603.kicad_mod'),
    '(footprint "R_0603" (layer "F.Cu") (fp_rect (start -2 -1) (end 2 1)) (pad "1" smd rect (at -1 0) (size 0.8 0.9)))',
  );
  fs.writeFileSync(
    path.join(pcb, 'board.kicad_pro'),
    JSON.stringify({ board: { design_settings: { layers: 2 } } }),
  );
  fs.writeFileSync(
    path.join(pcb, 'board.kicad_dru'),
    '(version 1)\n(rule "width" (constraint track_width (min 0.2mm)))\n',
  );
  const gerber =
    '%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.2*%\nD10*\nX010000Y010000D02*\nX020000Y010000D01*\nX020000Y020000D03*\nM02*';
  fs.writeFileSync(path.join(pcb, 'board-F_Cu.gbr'), gerber);
  fs.writeFileSync(path.join(pcb, 'board-B_Cu.gbr'), gerber);
  fs.writeFileSync(
    path.join(pcb, 'board-PTH.drl'),
    'M48\nMETRIC,TZ\nT01C0.8\n%\nT01\nX1.0Y2.0\nM30\n',
  );
  fs.writeFileSync(
    path.join(pcb, 'body.step'),
    "ISO-10303-21;\nDATA;\n#1 = CARTESIAN_POINT('',(1.0,2.0,3.0));\nENDSEC;\nEND-ISO-10303-21;",
  );
  fs.writeFileSync(
    path.join(pcb, 'body.wrl'),
    '#VRML V2.0 utf8\nShape { geometry IndexedFaceSet { coord Coordinate { point [0 0 0, 1 0 0, 0 1 0] } coordIndex [0, 1, 2, -1] } }',
  );
  fs.writeFileSync(path.join(pcb, 'bad.gbr'), 'invalid Gerber');
  saveBindings(config, {
    activeId: 'engineering-godot',
    projects: [
      {
        id: 'engineering-godot',
        name: 'Engineering Godot',
        path: fs.realpathSync(godot),
        domain: 'godot',
      },
      { id: 'engineering-pcb', name: 'Engineering PCB', path: fs.realpathSync(pcb), domain: 'pcb' },
    ],
  });
}
async function run(window) {
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  async function wait(script) {
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error(`Engineering Viewer condition timed out: ${script}`);
  }
  async function open(file, format) {
    await wait(
      `Boolean(document.querySelector('.ia-file-list button[title=${JSON.stringify(file)}]'))`,
    );
    await evaluate(
      `document.querySelector('.ia-file-list button[title=${JSON.stringify(file)}]').click()`,
    );
    await wait(
      `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-engineering-toolbar strong')?.textContent === ${JSON.stringify(path.basename(file))} && document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-engineering')?.dataset.engineeringFormat === ${JSON.stringify(format)} && document.querySelector('.ia-viewer-footer')?.innerText.includes('ENGINEERING · Ready')`,
    );
  }
  const requests = [];
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    if (/^https?:/.test(details.url)) requests.push(details.url);
    callback({ cancel: /^https?:/.test(details.url) });
  });
  try {
    await wait(`document.querySelector('.ia-domain-pill')?.innerText.includes('Godot')`);
    await evaluate(`document.querySelector('.ia-chat-actions button:last-child').click()`);
    await wait(`Boolean(document.querySelector('.ia-file-tree-toggle'))`);
    await evaluate(`document.querySelector('.ia-file-tree-toggle').click()`);
    await open('playground.tscn', 'Godot scene');
    fs.writeFileSync(
      path.join(godot, 'scene-preview.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    assert.ok(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])').querySelectorAll('.rp-engineering-row').length >= 6`,
      ),
    );
    const measure = () =>
      evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-engineering-properties h3').getBoundingClientRect().height`,
      );
    await verifyNavigation(window, measure);
    await verifyWheelScroll(window, measure, (delta, ctrl) =>
      evaluate(
        `(() => {const element=document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-engineering-viewport'); const event=new WheelEvent('wheel',{deltaY:${delta},ctrlKey:${ctrl},cancelable:true});element.dispatchEvent(event);return event.defaultPrevented;})()`,
      ),
    );
    await evaluate(
      `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-engineering-tabs button:last-child').click()`,
    );
    await wait(
      `Boolean(document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-assets'))`,
    );
    await evaluate(
      `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-engineering-tabs button:first-child').click()`,
    );
    await wait(
      `Boolean(document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-engineering-properties'))`,
    );
    await open('playground.gd', 'GDScript');
    assert.ok(
      await evaluate(
        `Boolean(document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-engineering-keyword'))`,
      ),
    );
    for (const [name, format] of [
      ['project.godot', 'Godot project'],
      ['theme.tres', 'Godot resource'],
      ['theme.res', 'Godot binary resource'],
      ['sound.wav', 'Godot audio'],
      ['mesh.obj', '3D OBJ mesh'],
      ['model.gltf', 'Godot glTF model'],
      ['model.glb', 'Godot GLB model'],
    ])
      await open(name, format);
    assert.ok(
      await evaluate(
        `Boolean(document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-engineering-properties'))`,
      ),
    );
    await evaluate(
      `Array.from(document.querySelectorAll('button.ia-project-row')).find(button=>button.textContent.includes('Engineering PCB')).click()`,
    );
    await wait(
      `document.querySelector('.ia-project-row.selected')?.textContent.includes('Engineering PCB')`,
    );
    await wait(`document.querySelector('.ia-new-chat')?.disabled === false`);
    await evaluate(`document.querySelector('.ia-new-chat').click()`);
    await wait(`document.querySelector('.ia-domain-pill')?.innerText.includes('PCB')`);
    await evaluate(`document.querySelector('.ia-chat-actions button:last-child').click()`);
    await wait(`Boolean(document.querySelector('.ia-file-tree-toggle'))`);
    await evaluate(`document.querySelector('.ia-file-tree-toggle').click()`);
    for (const [name, format] of [
      ['Device.kicad_sym', 'KiCad symbol library'],
      ['board.kicad_pro', 'KiCad project'],
      ['board.kicad_dru', 'KiCad design rules'],
      ['board-F_Cu.gbr', 'PCB manufacturing'],
      ['body.step', 'STEP CAD model'],
      ['body.wrl', 'VRML 3D model'],
    ])
      await open(name, format);
    await open('Device.kicad_sym', 'KiCad symbol library');
    assert.equal(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])').querySelectorAll('.rp-engineering-outline input[type="checkbox"]:checked').length`,
      ),
      1,
    );
    await evaluate(
      `document.querySelector('.ia-file-view:not([hidden])').querySelectorAll('.rp-engineering-row button')[1].click()`,
    );
    assert.equal(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])').querySelectorAll('.rp-engineering-outline input[type="checkbox"]:checked').length`,
      ),
      1,
    );
    assert.ok(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])').querySelectorAll('.rp-engineering-outline input[type="checkbox"]')[1].checked`,
      ),
    );
    await open('body.wrl', 'VRML 3D model');
    assert.ok(
      await evaluate(
        `Boolean(document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-engineering-toolbar button')?.textContent.includes('Open in app'))`,
      ),
    );
    assert.equal(
      await evaluate(
        `window.viewerHost.openExternalArtifact('unknown-artifact').then(() => false, () => true)`,
      ),
      true,
    );
    await open('board-F_Cu.gbr', 'PCB manufacturing');
    fs.writeFileSync(
      path.join(pcb, 'manufacturing-preview.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    assert.equal(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])').querySelectorAll('.rp-engineering-geometry svg line').length`,
      ),
      2,
    );
    assert.equal(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])').querySelectorAll('.rp-engineering-outline input[type="checkbox"]').length`,
      ),
      3,
    );
    await evaluate(
      `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-engineering-outline input[type="checkbox"]').click()`,
    );
    assert.equal(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])').querySelectorAll('.rp-engineering-geometry svg line').length`,
      ),
      1,
    );
    await open('Resistor.pretty/R_0603.kicad_mod', 'KiCad footprint');
    assert.ok(
      await evaluate(
        `document.querySelector('.ia-file-view:not([hidden])')?.querySelector('.rp-engineering-geometry svg rect')`,
      ),
    );
    await evaluate(`document.querySelector('.ia-file-list button[title="bad.gbr"]').click()`);
    await wait(`document.body.innerText.includes('recognizable Gerber')`);
    assert.ok(
      !(await evaluate(`document.querySelector('.ia-viewer-footer')?.innerText.includes('Ready')`)),
    );
    assert.deepEqual(requests, []);
    console.log(
      JSON.stringify({
        ok: true,
        godotFormats: 10,
        pcbFormats: 7,
        navigation: true,
        fullscreen: true,
        layerToggle: true,
        malformedSource: true,
        externalRequests: requests.length,
      }),
    );
  } catch (error) {
    console.error('Engineering selftest projects:', godot, pcb);
    fs.writeFileSync(
      path.join(godot, 'failure.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    throw error;
  } finally {
    window.webContents.session.webRequest.onBeforeRequest(null);
  }
}
module.exports = { prepare, run };
