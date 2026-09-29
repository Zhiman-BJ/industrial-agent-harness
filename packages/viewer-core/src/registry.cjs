function createViewerRegistry(plugins) {
  const byId = new Map();
  for (const plugin of plugins) {
    if (!plugin || typeof plugin.id !== 'string' || typeof plugin.matches !== 'function' || typeof plugin.open !== 'function' || byId.has(plugin.id)) throw Error('Invalid or duplicate Viewer plugin.');
    byId.set(plugin.id, Object.freeze(plugin));
  }
  return Object.freeze({
    get(id) {return byId.get(id);},
    match(file) {return [...byId.values()].find(plugin => plugin.matches(file))?.id || null;},
    list() {return [...byId.keys()];},
  });
}
module.exports = {createViewerRegistry};
