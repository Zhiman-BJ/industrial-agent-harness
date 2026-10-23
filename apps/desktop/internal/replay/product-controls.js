/* global document, window */
'use strict';
let state,
  offset = 0;
const $ = id => document.getElementById(id);
const fail = error => {
  $('error').textContent = String(error);
};
async function control(request) {
  try {
    render(await window.replayControls.control(request));
  } catch (error) {
    fail(error);
  }
}
function render(next) {
  state = next;
  $('position').max = next.totalEvents;
  $('position').value = next.position;
  $('state').textContent =
    `${next.position} / ${next.totalEvents} · ${next.atEnd ? '已到记录终点' : next.phase === 'playing' ? '播放中' : '暂停'}`;
  $('play').textContent = next.phase === 'playing' ? '暂停' : '播放';
}
async function page() {
  try {
    const result = await window.replayControls.page({ offset });
    offset = result.offset;
    $('ledger').textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    fail(error);
  }
}
$('play').onclick = () => control({ action: state?.phase === 'playing' ? 'pause' : 'play' });
$('reset').onclick = () => control({ action: 'reset' });
$('speed').onchange = event => control({ action: 'speed', value: Number(event.target.value) });
$('position').onchange = event => control({ action: 'seek', value: Number(event.target.value) });
$('stages').onchange = event => control({ action: 'seek', value: Number(event.target.value) });
$('previous').onclick = () => {
  offset = Math.max(0, offset - 100);
  void page();
};
$('next').onclick = () => {
  offset += 100;
  void page();
};
window.replayControls.onChanged(render);
window.replayControls
  .metadata()
  .then(meta => {
    $('title').textContent = meta.manifest.chat?.displayName || meta.manifest.recordingId;
    for (const stage of meta.replayStages) {
      const option = document.createElement('option');
      option.value = stage.position;
      option.textContent = stage.title;
      $('stages').append(option);
    }
    render(meta);
  })
  .catch(fail);
