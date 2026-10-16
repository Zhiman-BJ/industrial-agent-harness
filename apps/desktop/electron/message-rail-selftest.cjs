// Regression coverage in the real renderer, with persisted chat history and native hit targets.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function run(window, store, project) {
  const evaluate = async script => {
    try {
      return await window.webContents.executeJavaScript(script, true);
    } catch (error) {
      throw Error(`Message rail selftest renderer script failed:\n${script}`, { cause: error });
    }
  };
  async function wait(script) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(script)) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error(`Message rail selftest timed out: ${script}`);
  }
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  async function capture(name) {
    if (!process.env.INDUSTRIAL_UI_SCREENSHOTS) return;
    await evaluate('document.fonts.ready');
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.mkdirSync(process.env.INDUSTRIAL_UI_SCREENSHOTS, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.INDUSTRIAL_UI_SCREENSHOTS, `${name}.png`),
      (await window.webContents.capturePage()).toPNG(),
    );
  }
  function seed(title, lengths) {
    const chat = store.create(project, 'chip');
    lengths.forEach((length, index) => {
      const turn = store.beginTurn(chat.id, `${title} ${index + 1}`);
      if (length)
        store.append(turn, {
          type: 'text',
          text: 'Inspect the project files and retain the verification evidence.\n\n'.repeat(
            length,
          ),
        });
      store.finish(turn, 'completed');
    });
    return chat.id;
  }
  const longTitle =
    'Rail long transcript — preserve reading position, timing constraints and verification evidence';
  const longChat = seed('Rail long transcript', [1, 18, 1, 35, 1, 70]);
  store.rename(longChat, project, 'chip', longTitle);
  seed('Rail short transcript', [0, 0]);
  seed('Rail sampled history', Array(120).fill(1));
  window.setContentSize(1280, 720);
  window.webContents.reload();
  await wait(`document.querySelectorAll('.ia-sidebar-chat').length >= 3`);
  if (await evaluate(`Boolean(document.querySelector('.theme-dark'))`)) {
    await click('.ia-settings-button');
    await evaluate(`document.querySelector('.ia-settings-row button').click()`);
    await click('.ia-settings-title button');
  }
  async function select(title, count) {
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-sidebar-chat')).find(node => node.textContent.includes(${JSON.stringify(title)})).click()`,
    );
    await wait(`document.querySelectorAll('.ia-chat-turn').length === ${count}`);
    await wait(`document.querySelectorAll('.ia-rail-tick').length >= 2`);
    await evaluate(
      `document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`,
    );
  }
  const geometry = () =>
    evaluate(`(() => {
    const rail = document.querySelector('.ia-message-rail').getBoundingClientRect();
    const scroll = document.querySelector('.ia-chat-scroll');
    const ticks = Array.from(document.querySelectorAll('.ia-rail-tick')).map(node => {
      const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, right: r.right, x: r.left + 3, y: r.top + r.height / 2 };
    });
    return { ticks, contentLeft: document.querySelector('.ia-chat-turn').getBoundingClientRect().left, rail: {top: rail.top, bottom: rail.bottom}, scrollable: scroll.scrollHeight > scroll.clientHeight + 40 };
  })()`);
  async function compact(count, scrollable) {
    const result = await geometry();
    if (count) assert.equal(result.ticks.length, count);
    assert.equal(result.scrollable, scrollable);
    assert.ok(
      result.ticks.every(tick => tick.right < result.contentLeft),
      'The rail gutter must not overlap message content',
    );
    for (let index = 1; index < result.ticks.length; index++) {
      const gap = result.ticks[index].top - result.ticks[index - 1].top;
      assert.ok(gap >= 7 && gap <= 10, `Adjacent ticks must stay compact; actual pitch ${gap}px`);
      assert.ok(
        result.ticks[index].top >= result.ticks[index - 1].bottom - 0.5,
        'Tick hit targets must not overlap',
      );
    }
    const first = result.ticks[0],
      last = result.ticks.at(-1);
    assert.ok(first.top >= result.rail.top && last.bottom <= result.rail.bottom);
    assert.ok(
      Math.abs((first.top + last.bottom) / 2 - (result.rail.top + result.rail.bottom) / 2) < 2,
      'Ticks form a centered group',
    );
    return result.ticks.map(tick => tick.top - (result.rail.top + result.rail.bottom) / 2);
  }
  async function point(index) {
    const { ticks } = await geometry();
    return { x: Math.round(ticks[index].x), y: Math.round(ticks[index].y) };
  }
  await select('Rail long transcript', 6);
  await wait(
    `document.querySelector('[data-testid="header-location"]')?.title === ${JSON.stringify(longTitle)}`,
  );
  assert.equal(
    await evaluate(`(() => {
    const message=document.querySelector('.ia-chat-turn').getBoundingClientRect();
    const composer=document.querySelector('.ia-composer').getBoundingClientRect();
    return Math.abs(message.width-640)<=1 && Math.abs(message.left-composer.left)<=1 && Math.abs(message.right-composer.right)<=1;
  })()`),
    true,
    'Real messages and composer must share the 640 px content boundaries',
  );
  await evaluate(
    `(() => { const box=document.querySelector('.ia-chat-scroll'); box.scrollTo({top:box.scrollHeight,behavior:'instant'}); })()`,
  );
  await wait(
    `document.querySelectorAll('.ia-rail-tick')[5].getAttribute('aria-current') === 'true'`,
  );
  // Capture before asserting so a regression retains the visible failure too.
  await capture('rail-long-idle');
  const positions = await compact(6, true);
  window.focus();
  window.webContents.focus();
  const target = await point(2);
  window.webContents.sendInputEvent({ type: 'mouseMove', ...target });
  await wait(
    `document.querySelector('.ia-rail-preview b')?.textContent === 'Rail long transcript 3'`,
  );
  await wait(`document.querySelectorAll('.ia-rail-tick')[2].matches(':hover')`);
  await capture('rail-long-hover');
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...target,
  });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...target });
  await wait(`(() => {
    const box = document.querySelector('.ia-chat-scroll').getBoundingClientRect();
    const turn = document.querySelectorAll('.ia-chat-turn')[2].getBoundingClientRect();
    return Math.abs(turn.top - box.top) < 2 && document.querySelectorAll('.ia-rail-tick')[2].getAttribute('aria-current') === 'true';
  })()`);
  assert.deepEqual(
    await compact(6, true),
    positions,
    'Scrolling must not change tick offsets within the centered group',
  );
  await evaluate(
    `document.querySelectorAll('.ia-chat-turn')[3].scrollIntoView({block:'start',behavior:'instant'}); document.querySelector('.ia-chat-scroll').scrollTop += 180`,
  );
  await wait(
    `document.querySelectorAll('.ia-rail-tick')[3].getAttribute('aria-current') === 'true'`,
  );
  await evaluate(`(() => {
    window.__readingScroll=document.querySelector('.ia-chat-scroll');
    window.__readingTurn=document.querySelectorAll('.ia-chat-turn')[3];
    window.__readingOffset=window.__readingTurn.getBoundingClientRect().top-window.__readingScroll.getBoundingClientRect().top;
    window.__readingTop=window.__readingScroll.scrollTop;
  })()`);
  for (const selector of [
    '[data-testid="sidebar-toggle"]',
    '[data-testid="sidebar-toggle"]',
    '.ia-layout-toggle',
    '.ia-layout-toggle',
  ]) {
    await click(selector);
    await evaluate(
      `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`,
    );
    assert.equal(
      await evaluate(`(() => {
      const scroll=document.querySelector('.ia-chat-scroll'), turn=document.querySelectorAll('.ia-chat-turn')[3];
      return scroll===window.__readingScroll && turn===window.__readingTurn &&
        Math.abs(scroll.scrollTop-window.__readingTop)<=1 &&
        Math.abs(turn.getBoundingClientRect().top-scroll.getBoundingClientRect().top-window.__readingOffset)<=1;
    })()`),
      true,
      'Shell navigation must retain the transcript nodes and reading anchor when content does not reflow',
    );
  }
  window.setContentSize(640, 480);
  await wait(`innerWidth === 640`);
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  assert.equal(
    await evaluate(`(() => {
    const title=document.querySelector('[data-testid="header-location"]');
    const actions=document.querySelector('.ia-desktop-actions').getBoundingClientRect();
    const rect=title.getBoundingClientRect();
    return title.title===${JSON.stringify(longTitle)} && rect.width>0 && rect.right<=actions.left+1;
  })()`),
    true,
    'A long chat title must preserve its full accessible title without overlapping actions at minimum width',
  );
  window.setContentSize(1280, 720);
  await wait(`innerWidth === 1280`);
  await wait(`document.querySelector('.ia-settings-button')?.getClientRects().length > 0 &&
    document.querySelector('.ia-chat-scroll')?.clientHeight > 0 &&
    document.querySelectorAll('.ia-rail-tick').length === 6`);
  await evaluate(
    `document.querySelectorAll('.ia-chat-turn')[3].scrollIntoView({block:'start',behavior:'instant'}); document.querySelector('.ia-chat-scroll').scrollTop += 180`,
  );
  await evaluate(`document.querySelector('.ia-rail-tick[aria-label="Jump to message 5"]').focus()`);
  await wait(
    `document.querySelector('.ia-rail-preview b')?.textContent === 'Rail long transcript 5'`,
  );
  assert.equal(
    await evaluate(`(() => {
    const preview = document.querySelector('.ia-rail-preview').getBoundingClientRect();
    const rail = document.querySelector('.ia-message-rail').getBoundingClientRect();
    return preview.top >= rail.top && preview.bottom <= rail.bottom;
  })()`),
    true,
    'Keyboard preview must stay inside the viewport',
  );
  await evaluate(`document.querySelector('.ia-composer textarea').focus()`);
  await wait(`!document.querySelector('.ia-rail-preview')`);
  // Use the application theme control, keeping the persisted preference in sync.
  await click('.ia-settings-button');
  await evaluate(`document.querySelector('.ia-settings-row button').click()`);
  await click('.ia-settings-title button');
  await compact(6, true);
  await capture('rail-long-other-theme');
  await select('Rail short transcript', 2);
  await compact(2, false);
  await capture('rail-short');
  await select('Rail sampled history', 10);
  while (await evaluate(`Boolean(document.querySelector('.ia-history-more'))`)) {
    const count = await evaluate(`document.querySelectorAll('.ia-chat-turn').length`);
    await click('.ia-history-more');
    await wait(`document.querySelectorAll('.ia-chat-turn').length > ${count}`);
  }
  assert.equal(await evaluate(`document.querySelectorAll('.ia-chat-turn').length`), 120);
  await compact(null, true);
  assert.equal(
    await evaluate(`document.querySelector('.ia-rail-tick').getAttribute('aria-label')`),
    'Jump to message 1',
  );
  assert.equal(
    await evaluate(
      `Array.from(document.querySelectorAll('.ia-rail-tick')).at(-1).getAttribute('aria-label')`,
    ),
    'Jump to message 120',
  );
  await evaluate(`document.querySelector('.ia-chat-scroll').scrollTo({top:0,behavior:'instant'})`);
  await wait(
    `document.querySelector('.ia-rail-tick[aria-current="true"]') === document.querySelector('.ia-rail-tick')`,
  );
  window.setContentSize(640, 480);
  await wait(`innerWidth <= 640`);
  await wait(
    `document.querySelectorAll('.ia-rail-tick').length <= Math.max(2, Math.floor(document.querySelector('.ia-chat-scroll').clientHeight / 16))`,
  );
  await compact(null, true);
  await capture('rail-sampled-minimum');
  await evaluate(`Array.from(document.querySelectorAll('.ia-rail-tick')).at(-1).click()`);
  await wait(
    `(() => {
      const box = document.querySelector('.ia-chat-scroll').getBoundingClientRect();
      const last = Array.from(document.querySelectorAll('.ia-chat-turn')).at(-1).getBoundingClientRect();
      return last.top >= box.top - 2 && last.top < box.bottom;
    })()`,
  );
  await wait(
    `document.querySelector('.ia-rail-tick[aria-current="true"]') === Array.from(document.querySelectorAll('.ia-rail-tick')).at(-1)`,
  );
  window.webContents.debugger.attach('1.3');
  try {
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    assert.equal(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true);
    assert.equal(
      await evaluate(`(() => {
      document.querySelector('.ia-rail-tick').click();
        return document.querySelector('.ia-chat-turn').getBoundingClientRect().top - document.querySelector('.ia-chat-scroll').getBoundingClientRect().top;
    })()`),
      0,
      'Reduced motion jumps immediately without a scroll animation',
    );
    await evaluate(`document.querySelector('.ia-rail-tick').focus()`);
    await wait(`Boolean(document.querySelector('.ia-rail-preview'))`);
    assert.equal(
      await evaluate(`getComputedStyle(document.querySelector('.ia-rail-preview')).animationName`),
      'none',
    );
  } finally {
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    window.webContents.debugger.detach();
  }
  console.log(
    'Message rail selftest passed: compact short/uneven long transcripts, native hover/click, stable positions, current long turn, keyboard preview, themes, sampled 120-turn history, first/last jumps, minimum window, and reduced motion.',
  );
}

module.exports = { run };
