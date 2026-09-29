// A bounded reader for sprite metadata. Never evaluates GDScript or instantiates scenes.
function variant(source) {
  const tokens = []; let end = 0;
  const lexer = /&?"(?:\\.|[^"\\])*"|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[A-Za-z_]\w*|[()[\]{},:]/g;
  for (const match of source.matchAll(lexer)) {
    if (source.slice(end, match.index).trim()) throw Error('Unsupported sprite metadata syntax.');
    tokens.push(match[0]); end = match.index + match[0].length;
    if (tokens.length > 20000) throw Error('Sprite metadata exceeds resource limits.');
  }
  if (source.slice(end).trim()) throw Error('Unsupported sprite metadata syntax.');
  let i = 0;
  function read(depth = 0) {
    if (depth > 24) throw Error('Sprite metadata nesting exceeds resource limits.');
    const token = tokens[i++];
    if (!token) throw Error('Incomplete sprite metadata.');
    if (token.startsWith('"') || token.startsWith('&"')) return JSON.parse(token.replace(/^&/, ''));
    if (/^[-+\d.]/.test(token)) {const n = Number(token); if (!Number.isFinite(n)) throw Error('Invalid number.'); return n;}
    if (token === 'true' || token === 'false') return token === 'true';
    if (token === '[' || token === '{') {
      const close = token === '[' ? ']' : '}'; const result = token === '[' ? [] : Object.create(null);
      while (tokens[i] !== close) {
        if (token === '[') result.push(read(depth + 1));
        else {const key = read(depth + 1); if (typeof key !== 'string' || tokens[i++] !== ':') throw Error('Invalid metadata property.'); result[key] = read(depth + 1);}
        if (tokens[i] !== close && tokens[i++] !== ',') throw Error('Invalid metadata list.');
      }
      i++; return result;
    }
    if (!['ExtResource', 'SubResource', 'Rect2', 'PackedFloat32Array', 'PackedFloat64Array', 'NodePath'].includes(token) || tokens[i++] !== '(') throw Error('Unsupported sprite metadata value.');
    const args = [];
    while (tokens[i] !== ')') {args.push(read(depth + 1)); if (tokens[i] !== ')' && tokens[i++] !== ',') throw Error('Invalid metadata arguments.');}
    i++;
    if (token.endsWith('Resource')) {if (args.length !== 1 || typeof args[0] !== 'string') throw Error('Invalid resource reference.'); return {ref: args[0], external: token === 'ExtResource'};}
    if (token === 'NodePath') return args[0];
    return args;
  }
  const result = read(); if (i !== tokens.length) throw Error('Unexpected metadata content.'); return result;
}

function blocks(source) {
  return [...source.matchAll(/^\[([^\r\n]+)\]\s*$/gm)].map((match, index, all) => {
    const header = match[1]; const attrs = Object.fromEntries([...header.matchAll(/(\w+)="((?:\\.|[^"\\])*)"/g)].map(m => [m[1], JSON.parse(`"${m[2]}"`)]));
    return {kind: header.split(' ')[0], ...attrs, body: source.slice(match.index + match[0].length, all[index + 1]?.index ?? source.length)};
  });
}
function field(body, key, fallback) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${escaped} = ([\\s\\S]*?)(?=^[\\w/]+ = |$(?![\\s\\S]))`, 'm').exec(body);
  return match ? variant(match[1].trim()) : fallback;
}

function readGodotSprites(source) {
  const sections = blocks(source); const externals = new Map(sections.filter(b => b.kind === 'ext_resource').map(b => [b.id, b]));
  const resources = new Map(sections.filter(b => b.kind === 'sub_resource').map(b => [b.id, b]));
  const textures = [];
  function texture(ref, depth = 0) {
    if (depth > 16) throw Error('Texture references exceed resource limits.');
    if (!ref || typeof ref !== 'object') throw Error('Missing sprite texture reference.');
    if (ref.external) {
      const resource = externals.get(ref.ref);
      if (resource?.type !== 'Texture2D' || !resource.path) throw Error('Only project Texture2D images are supported.');
      let image = textures.indexOf(resource.path); if (image < 0) {image = textures.length; textures.push(resource.path);}
      return {image, rect: null};
    }
    const resource = resources.get(ref.ref);
    if (resource?.type !== 'AtlasTexture') throw Error('Only Texture2D and AtlasTexture frames are supported.');
    const base = texture(field(resource.body, 'atlas'), depth + 1); const rect = field(resource.body, 'region');
    if (!Array.isArray(rect) || rect.length !== 4 || base.rect) throw Error('Unsupported atlas region.');
    if (field(resource.body, 'margin', [0, 0, 0, 0]).some(n => n !== 0)) throw Error('Atlas margins are not supported in V1.');
    return {...base, rect};
  }
  const spriteFrames = sections.filter(b => b.type === 'SpriteFrames');
  if (spriteFrames.length) {
    if (spriteFrames.length !== 1) throw Error('Open a resource containing one SpriteFrames set.');
    const body = spriteFrames[0].kind === 'gd_resource' ? sections.find(b => b.kind === 'resource')?.body : spriteFrames[0].body;
    const animations = field(body || '', 'animations');
    if (!Array.isArray(animations)) throw Error('Missing SpriteFrames animations.');
    return {textures, animations: animations.map(a => {
      if (!Array.isArray(a.frames) || !Number.isFinite(a.speed) || a.speed <= 0) throw Error('Invalid SpriteFrames animation.');
      return {name: a.name, loop: Boolean(a.loop), frames: a.frames.map(f => ({...texture(f.texture), duration: (f.duration ?? 1) / a.speed}))};
    })};
  }
  const sprites = sections.filter(b => b.kind === 'node' && b.type === 'Sprite2D');
  const animations = []; let sprite; let image;
  const names = new Map();
  for (const library of sections.filter(b => b.type === 'AnimationLibrary')) {
    for (const [name, ref] of Object.entries(field(library.body, '_data', {}))) if (ref && !ref.external) names.set(ref.ref, name);
  }
  for (const resource of sections.filter(b => b.type === 'Animation')) {
    const paths = [...resource.body.matchAll(/^tracks\/(\d+)\/path = NodePath\("([^"\n]+):frame"\)/gm)];
    if (!paths.length) continue;
    if (paths.length !== 1) throw Error('Multiple sprite tracks are not supported in V1.');
    const [, track, nodePath] = paths[0];
    const target = sprites.find(b => (b.parent === '.' ? b.name : `${b.parent}/${b.name}`) === nodePath);
    if (!target || (sprite && sprite !== target)) throw Error('Open a scene animating one Sprite2D.');
    sprite = target; image ??= texture(field(sprite.body, 'texture'));
    if (field(sprite.body, 'region_enabled', false)) throw Error('Sprite2D region clipping is not supported in V1.');
    if (image.rect) throw Error('Sprite2D atlas textures are not supported in V1.');
    if (field(resource.body, `tracks/${track}/type`) !== 'value' || field(resource.body, `tracks/${track}/interp`, 1) !== 1) throw Error('Unsupported sprite frame track.');
    const keys = field(resource.body, `tracks/${track}/keys`); const length = field(resource.body, 'length', 1);
    if (!keys || !Array.isArray(keys.times) || !Array.isArray(keys.values) || keys.times.length !== keys.values.length || !keys.times.length || keys.times[0] !== 0 || keys.update !== 1) throw Error('Only discrete frame tracks starting at zero are supported.');
    const loopMode = field(resource.body, 'loop_mode', 0);
    if (![0, 1].includes(loopMode)) throw Error('Ping-pong frame tracks are not supported in V1.');
    animations.push({name: names.get(resource.id) || field(resource.body, 'resource_name', resource.id), loop: loopMode === 1,
      frames: keys.values.map((index, n) => ({image: image.image, index, duration: (keys.times[n + 1] ?? length) - keys.times[n]}))});
  }
  if (!animations.length) throw Error('No supported sprite animations found.');
  return {textures, columns: field(sprite.body, 'hframes', 1), rows: field(sprite.body, 'vframes', 1), animations};
}
module.exports = {readGodotSprites};
