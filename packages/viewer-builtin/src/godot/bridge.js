(() => {
  const channel = 'industrial-harness-godot-v1';
  let callback = null;
  const pending = [];
  const bridge = Object.freeze({
    register(fn) {
      if (typeof fn !== 'function') return;
      callback = fn;
      while (pending.length) callback(pending.shift());
      window.parent.postMessage({channel, type: 'ready'}, '*');
    },
    emit(json) {
      let payload;
      try {payload = typeof json === 'string' ? JSON.parse(json) : json;} catch {return;}
      if (!payload || typeof payload !== 'object' || !['state', 'response', 'error'].includes(payload.type)) return;
      window.parent.postMessage({channel, type: payload.type, id: payload.id, data: payload.data, error: payload.error}, '*');
    }
  });
  Object.defineProperty(window, 'HarnessGodotBridge', {value: bridge, writable: false});
  window.addEventListener('message', event => {
    if (event.source !== window.parent || !event.data || event.data.channel !== channel || event.data.type !== 'command') return;
    if (!Number.isSafeInteger(event.data.id) || typeof event.data.command !== 'string') return;
    const encoded = JSON.stringify({id: event.data.id, command: event.data.command, args: event.data.args || {}});
    if (callback) callback(encoded); else if (pending.length < 32) pending.push(encoded);
  });
  document.addEventListener('wheel', event => {
    if (event.shiftKey || event.target?.tagName !== 'CANVAS') return;
    event.preventDefault(); event.stopImmediatePropagation();
    window.parent.postMessage({channel, type:'wheel', deltaY:event.deltaY, deltaMode:event.deltaMode}, '*');
  }, {capture:true, passive:false});
  window.parent.postMessage({channel, type: 'loaded'}, '*');
})();
