const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { saveBindings } = require('./project-bindings.cjs');
const { setLanguage } = require('./selftest-language.cjs');

let fixture;
function prepare(directory) {
  const registry = require('@industrial-agent-harness/domain-skills').loadRegistry();
  const agent = registry.agents?.[0];
  assert.ok(agent, 'Agent UI acceptance requires a real consumed Domain Pack Agent.');
  const project = path.join(directory, 'agent-project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'notes.txt'), 'Agent configuration UI fixture.\n');
  fixture = {
    projectId: 'agent-ui-project',
    project,
    domain: agent.domain,
    packAgentId: agent.id,
    directory,
  };
  saveBindings(directory, {
    activeId: fixture.projectId,
    projects: [
      {
        id: fixture.projectId,
        name: 'Agent configuration test',
        path: fs.realpathSync(project),
        domain: agent.domain,
      },
    ],
  });
}

async function run(window) {
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  async function wait(script) {
    const deadline = Date.now() + 20000;
    while (!(await evaluate(script))) {
      if (Date.now() > deadline) {
        throw Error(
          `Agent UI did not settle: ${script}\n${await evaluate('document.body.innerText')}`,
        );
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  const row = id => `[data-agent-profile-id=${JSON.stringify(id)}]`;
  async function click(selector) {
    await wait(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  async function input(selector, value) {
    await evaluate(
      `(() => { const node=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,'value').set.call(node, ${JSON.stringify(value)}); node.dispatchEvent(new Event('input',{bubbles:true})); })()`,
    );
    await wait(
      `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`,
    );
  }
  async function select(selector, value) {
    await evaluate(
      `(() => {const node=document.querySelector(${JSON.stringify(selector)}); node.value=${JSON.stringify(value)}; node.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
  }
  async function agentsPage() {
    await click('.ia-settings-button');
    await wait(
      `Array.from(document.querySelectorAll('.ia-settings-row')).some(row => row.querySelector('span')?.textContent === 'Agents')`,
    );
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-settings-row')).find(row => row.querySelector('span')?.textContent === 'Agents').querySelector('button').click()`,
    );
    await wait(`Boolean(document.querySelector('.ia-agent-group'))`);
  }
  const catalog = () => evaluate('window.viewerHost.agentList()');
  const projectCatalog = () =>
    evaluate(`window.viewerHost.agentList({projectId:${JSON.stringify(fixture.projectId)}})`);
  const activeChat = () =>
    evaluate(
      'window.viewerHost.chats().then(list => list.chats.find(chat => chat.id === list.activeId))',
    );
  await setLanguage(window, 'en');
  await wait(`Boolean(document.querySelector('.ia-chat-agent select:not(:disabled)'))`);
  assert.equal(await activeChat(), undefined, 'Opening a project does not manufacture a chat.');
  await input('.ia-composer textarea', 'Keep this unsent task while choosing an agent.');
  await select('.ia-chat-agent select', 'builtin:explore');
  await wait(
    `document.querySelector('.ia-chat-agent select')?.value === 'builtin:explore' && !document.querySelector('.ia-chat-agent select').disabled`,
  );
  assert.equal((await activeChat()).agent.id, 'builtin:explore');
  assert.equal(
    await evaluate(`document.querySelector('.ia-composer textarea').value`),
    'Keep this unsent task while choosing an agent.',
  );
  await agentsPage();
  const original = (await catalog()).agents.find(agent => agent.id === fixture.packAgentId);
  assert.equal(original.source, 'pack');
  assert.equal(original.editable, false);
  assert.equal(
    await evaluate(
      `Boolean(document.querySelector(${JSON.stringify(row('builtin:default') + ' .ia-agent-copy')}))`,
    ),
    false,
    'Built-ins keep upstream profiles instead of copying an empty instruction body.',
  );
  await click(row(original.id) + ' .ia-agent-open');
  await wait(`document.querySelector('.ia-agent-fields')?.disabled === true`);
  assert.equal(
    await evaluate(`document.querySelector('.ia-agent-fields textarea').value`),
    original.instructions,
  );
  assert.equal(
    await evaluate(`Boolean(document.querySelector('.ia-agent-editor button[type="submit"]'))`),
    false,
  );
  await click('.ia-agent-back');
  await click(row(original.id) + ' .ia-agent-copy');
  await wait(`document.querySelector('.ia-agent-fields')?.disabled === false`);
  await input('.ia-agent-fields input', 'UI custom agent');
  await input('.ia-agent-fields label:nth-child(2) input', 'Created by the actual Agent editor.');
  await input('.ia-agent-fields textarea', original.instructions + '\nUI_AGENT_FIRST_REVISION');
  await select('.ia-agent-choices select', 'selected');
  await wait(`Boolean(document.querySelector('.ia-agent-choices input'))`);
  await evaluate(
    `Array.from(document.querySelector('.ia-agent-choices').querySelectorAll('label')).find(label => label.textContent.trim() === 'Read files').querySelector('input').click()`,
  );
  await click('.ia-agent-editor button[type="submit"]');
  await wait(
    `!document.querySelector('.ia-agent-editor') && Array.from(document.querySelectorAll('.ia-agent-row-name')).some(node => node.textContent === 'UI custom agent')`,
  );
  let custom = (await catalog()).agents.find(agent => agent.name === 'UI custom agent');
  assert.equal(custom.source, 'custom');
  assert.equal(custom.editable, true);
  assert.equal(custom.domain, original.domain);
  assert.deepEqual(custom.tools, ['Read']);
  assert.equal(custom.instructions, original.instructions + '\nUI_AGENT_FIRST_REVISION');
  assert.equal(
    (await catalog()).agents.find(agent => agent.id === original.id).revision,
    original.revision,
    'Copy never changes the Pack definition.',
  );

  await click(row(custom.id) + ' .ia-agent-open');
  const evidence = path.join(fixture.directory, 'agent-ui-evidence');
  fs.mkdirSync(evidence, { recursive: true });
  await new Promise(resolve => setTimeout(resolve, 300));
  fs.writeFileSync(
    path.join(evidence, 'agent-editor-en.png'),
    (await window.webContents.capturePage()).toPNG(),
  );
  await input('.ia-agent-fields textarea', original.instructions + '\nUI_AGENT_SECOND_REVISION');
  await click('.ia-agent-editor button[type="submit"]');
  await wait(`!document.querySelector('.ia-agent-editor')`);
  const edited = (await catalog()).agents.find(agent => agent.id === custom.id);
  assert.notEqual(edited.revision, custom.revision);
  custom = edited;

  // Exercise project default and draft selection through visible controls.
  await click('.ia-capability-header button');
  await click('.ia-project-row');
  await wait(`Boolean(document.querySelector('.ia-project-agent select:not(:disabled)'))`);
  await select('.ia-project-agent select', custom.id);
  await wait(
    `document.querySelector('.ia-project-agent select')?.value === ${JSON.stringify(custom.id)} && !document.querySelector('.ia-project-agent select').disabled`,
  );
  assert.equal((await projectCatalog()).defaultAgentId, custom.id);
  await click('.ia-project-start');
  await wait(
    `document.querySelector('.ia-chat-agent select')?.value === ${JSON.stringify(custom.id)}`,
  );
  await select('.ia-chat-agent select', 'builtin:explore');
  await wait(
    `document.querySelector('.ia-chat-agent select')?.value === 'builtin:explore' && !document.querySelector('.ia-chat-agent select').disabled`,
  );
  assert.equal((await activeChat()).agent.id, 'builtin:explore');
  await select('.ia-chat-agent select', custom.id);
  await wait(
    `document.querySelector('.ia-chat-agent select')?.value === ${JSON.stringify(custom.id)} && !document.querySelector('.ia-chat-agent select').disabled`,
  );
  const selected = await activeChat();
  assert.equal(selected.agentLocked, false);

  // Preparing one real task records the first turn and locks the snapshot.
  // This is the real IPC/application/Broker path; no model request is necessary.
  await evaluate(
    `window.viewerHost.resolve({task:'Summarize the project files.',chatId:${JSON.stringify(selected.id)}})`,
  );
  const locked = await activeChat();
  assert.equal(locked.agentLocked, true);
  await assert.rejects(() =>
    evaluate(
      `window.viewerHost.chatSetAgent({chatId:${JSON.stringify(selected.id)},agentId:'builtin:default'})`,
    ),
  );
  await new Promise(resolve => {
    window.webContents.once('did-finish-load', resolve);
    window.webContents.reload();
  });
  await wait(`document.querySelector('.ia-chat-agent > span')?.textContent === 'UI custom agent'`);
  assert.equal(await evaluate(`Boolean(document.querySelector('.ia-chat-agent select'))`), false);
  assert.deepEqual((await activeChat()).agent, locked.agent);
  console.log(
    'Agent UI: Pack copy, custom editing, defaults, draft selection and locked reload passed.',
  );

  // Editing/deleting the catalog cannot rewrite a started chat's snapshot.
  await agentsPage();
  await click(row(custom.id) + ' .ia-agent-open');
  await input('.ia-agent-fields textarea', 'A later configuration for future chats.');
  await click('.ia-agent-editor button[type="submit"]');
  await wait(`!document.querySelector('.ia-agent-editor')`);
  assert.deepEqual((await activeChat()).agent, locked.agent);
  await click(row(custom.id) + ' .ia-agent-open');
  await click('.ia-agent-delete');
  await click('.ia-agent-delete-confirm button:last-child');
  await wait(
    `!document.querySelector('.ia-agent-editor') && !document.querySelector(${JSON.stringify(row(custom.id))})`,
  );
  assert.equal(
    (await catalog()).agents.some(agent => agent.id === custom.id),
    false,
  );
  assert.deepEqual((await activeChat()).agent, locked.agent);

  // A different project must never display the previous project's agent.
  await click('.ia-capability-header button');
  const otherProject = path.join(fixture.directory, 'other-agent-project');
  fs.mkdirSync(otherProject, { recursive: true });
  await evaluate(
    `window.viewerHost.createProject(${JSON.stringify({
      directory: otherProject,
      name: 'Other Agent project',
      domain: fixture.domain,
    })})`,
  );
  await wait(
    `document.querySelector('.ia-chat-agent select')?.value === 'builtin:default' && !document.querySelector('.ia-chat-agent select').disabled`,
  );
  assert.equal(await activeChat(), undefined);
  await input('.ia-composer textarea', 'A task for the new project.');
  await wait(`document.querySelector('.ia-send')?.disabled === false`);

  // Simulate an externally removed Pack default in isolated persisted settings.
  const settingsFile = path.join(fixture.directory, '..', 'resources', 'agent-profiles.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const projectKey = crypto
    .createHash('sha256')
    .update(JSON.stringify([fs.realpathSync(otherProject), fixture.domain]))
    .digest('hex');
  settings.defaults[projectKey] = 'pack:missing-agent';
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  await evaluate(`window.dispatchEvent(new Event('focus'))`);
  await wait(
    `document.querySelector('.ia-chat-agent select')?.value === 'pack:missing-agent' && document.querySelector('.ia-chat-agent [role="alert"]')?.textContent.includes('default agent is unavailable') && document.querySelector('.ia-send')?.disabled === true`,
  );
  await select('.ia-chat-agent select', 'builtin:default');
  await wait(
    `document.querySelector('.ia-chat-agent select')?.value === 'builtin:default' && document.querySelector('.ia-send')?.disabled === false`,
  );
  assert.equal((await activeChat()).agent.id, 'builtin:default');
  await evaluate(`window.viewerHost.selectProject(${JSON.stringify(fixture.projectId)})`);
  await wait(`document.querySelector('.ia-chat-agent > span')?.textContent === 'UI custom agent'`);
  assert.deepEqual((await activeChat()).agent, locked.agent);
  console.log('Agent UI: project switching and unavailable default recovery passed.');
  await agentsPage();

  await setLanguage(window, 'zh-CN');
  await wait(
    `document.querySelector('.ia-capability-nav button[aria-label="Agent"]')?.getAttribute('aria-current') === 'page'`,
  );
  assert.equal(await evaluate(`document.querySelector('.ia-agent-new').textContent`), '新建 Agent');
  window.setSize(640, 480);
  await wait(`window.innerWidth <= 640`);
  assert.ok(
    await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`),
    'Agent list fits the compact window.',
  );
  console.log('Agent UI: deletion preserves started chat, Chinese and compact layout passed.');
  await new Promise(resolve => setTimeout(resolve, 300));
  fs.writeFileSync(
    path.join(evidence, 'agents-zh-compact.png'),
    (await window.webContents.capturePage()).toPNG(),
  );
  console.log(
    'Agent UI selftest passed: Pack read-only/copy, custom create/edit/delete, project default, draft selection, persistent locked chat, Chinese and compact layout. Evidence: ' +
      evidence,
  );
}

module.exports = { prepare, run };
