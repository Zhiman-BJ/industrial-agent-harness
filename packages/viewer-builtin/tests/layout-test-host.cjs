const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Execute the real component callbacks/effects with a tiny hook host. This does
// not emulate browser painting, React reconciliation, or a native ResizeObserver.
function hookHost(elements = {}, initializeState = value => value) {
  const slots = [],
    effects = [],
    cleanups = new Map();
  let cursor = 0;
  const react = {
    useRef(value) {
      const index = cursor++;
      return (slots[index] ??= { current: value });
    },
    useState(value) {
      const index = cursor++;
      if (!(index in slots))
        slots[index] = initializeState(typeof value === 'function' ? value() : value);
      return [
        slots[index],
        next => {
          slots[index] = typeof next === 'function' ? next(slots[index]) : next;
        },
      ];
    },
    useContext: () => () => {},
    useCallback(callback, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((item, i) => !Object.is(item, previous.dependencies[i])))
        slots[index] = { callback, dependencies };
      return slots[index].callback;
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((item, i) => !Object.is(item, previous[i])))
        effects.push({ index, effect });
      slots[index] = dependencies;
    },
  };
  const jsx = (type, props) => {
    if (props?.ref && elements[type]) props.ref.current = elements[type];
    return { type, props: props || {} };
  };
  return {
    react,
    jsxRuntime: { jsx, jsxs: jsx, Fragment: Symbol('Fragment') },
    render(component, props) {
      cursor = 0;
      return component(props);
    },
    mountEffects() {
      for (const { index, effect } of effects.splice(0)) {
        cleanups.get(index)?.();
        cleanups.delete(index);
        const cleanup = effect();
        if (cleanup) cleanups.set(index, cleanup);
      }
    },
    unmount() {
      for (const cleanup of cleanups.values()) cleanup();
      cleanups.clear();
    },
  };
}

function loadComponent(filename, host, imports, globals = {}) {
  const compiled = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, '../src/layout', filename), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  const loaded = {};
  const dependencies = {
    react: host.react,
    'react/jsx-runtime': host.jsxRuntime,
    '../text': { useDisplayText: () => ({ t: key => key }) },
    ...imports,
  };
  new Function('require', 'exports', ...Object.keys(globals), compiled)(
    id => {
      assert.ok(Object.hasOwn(dependencies, id), `unexpected component dependency ${id}`);
      return dependencies[id];
    },
    loaded,
    ...Object.values(globals),
  );
  return loaded;
}

function nodes(root) {
  if (!root || typeof root !== 'object') return [];
  const children = [root.props?.children].flat(Infinity);
  return [root, ...children.flatMap(nodes)];
}
const meta = {
  token: 'test-source',
  cell: 'top',
  bbox: [0, 0, 1000, 1000],
  klayout: 'test',
  layers: [{ key: '1/0', name: '1/0' }],
};
module.exports = { hookHost, loadComponent, nodes, meta };
