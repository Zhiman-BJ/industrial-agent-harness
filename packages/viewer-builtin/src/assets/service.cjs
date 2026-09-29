const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {readGodotSprites} = require('./godot-text.cjs');
const maxImage = 16 * 1024 * 1024;
const maxText = 2 * 1024 * 1024;
const rasterExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

function imageSize(b) {
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && b.toString('ascii', 12, 16) === 'IHDR') return {width: b.readUInt32BE(16), height: b.readUInt32BE(20), mime: 'image/png'};
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const type = b.toString('ascii', 12, 16);
    if (type === 'VP8X') return {width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), mime: 'image/webp'};
    if (type === 'VP8 ' && b.toString('hex', 23, 26) === '9d012a') return {width: b.readUInt16LE(26) & 16383, height: b.readUInt16LE(28) & 16383, mime: 'image/webp'};
    if (type === 'VP8L' && b[20] === 47) {const n = b.readUInt32LE(21); return {width: 1 + (n & 16383), height: 1 + ((n >>> 14) & 16383), mime: 'image/webp'};}
  }
  if (b[0] === 255 && b[1] === 216) {
    let p = 2;
    while (p + 4 < b.length) {
      if (b[p++] !== 255) break;
      while (b[p] === 255) p++;
      const marker = b[p++]; if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = b.readUInt16BE(p); if (length < 2 || p + length > b.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 8) return {width: b.readUInt16BE(p + 5), height: b.readUInt16BE(p + 3), mime: 'image/jpeg'};
      p += length;
    }
  }
  throw Error('Unsupported or malformed PNG, JPEG or WebP image.');
}
function boundedFile(file, root, limit) {
  const canonical = fs.realpathSync(file); const project = fs.realpathSync(root);
  if (!canonical.startsWith(project + path.sep)) throw Error('Asset is outside the selected project.');
  const fd = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw Error('Asset is not a file.');
    if (stat.size > limit) throw Error('Asset exceeds Viewer resource limits.');
    const buffer = Buffer.alloc(stat.size); let offset = 0;
    while (offset < buffer.length) {const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset); if (!count) throw Error('Asset changed while loading.'); offset += count;}
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw Error('Asset changed while loading.');
    return {canonical, buffer};
  } finally {fs.closeSync(fd);}
}
function isAnimationFile(file) {
  if (!['.tscn', '.tres'].includes(path.extname(file).toLowerCase()) || fs.statSync(file).size > maxText) return false;
  const text = fs.readFileSync(file, 'utf8');
  return /type="SpriteFrames"/.test(text) || (/type="Animation"/.test(text) && /tracks\/\d+\/path = NodePath\("[^"\n]+:frame"\)/.test(text));
}

function createAssetPlugins({projectRoot}) {
  async function open(kind, {artifact, file}) {
    const root = fs.realpathSync(projectRoot()); const source = boundedFile(file, root, kind === 'image' ? maxImage : maxText);
    if (sha(source.buffer) !== artifact.sha256) throw Error('Asset changed; reopen the file.');
    let metadata;
    if (kind === 'image') metadata = {textures: [path.relative(root, source.canonical)], animations: []};
    else if (kind === 'sprite') {
      const json = JSON.parse(source.buffer.toString('utf8'));
      if (json.version !== 1 || typeof json.image !== 'string') throw Error('Sprite descriptor requires version 1 and a project image path.');
      metadata = {textures: [json.image], columns: json.columns, rows: json.rows, animations: json.animations ?? []};
    } else metadata = readGodotSprites(source.buffer.toString('utf8'));
    if (!Array.isArray(metadata.textures) || !metadata.textures.length || metadata.textures.length > 32) throw Error('Sprite texture count exceeds resource limits.');
    let total = 0; let pixels = 0;
    const images = metadata.textures.map(relative => {
      if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.startsWith('user://') || (/^[\w+.-]+:/.test(relative) && !relative.startsWith('res://'))) throw Error('Use project-relative texture paths.');
      const image = boundedFile(path.resolve(root, relative.replace(/^res:\/\//, '')), root, maxImage);
      if ((total += image.buffer.length) > 32 * 1024 * 1024) throw Error('Combined textures exceed Viewer resource limits.');
      const size = imageSize(image.buffer);
      if (size.width < 1 || size.height < 1 || size.width > 8192 || size.height > 8192 || size.width * size.height > 32 * 1024 * 1024) throw Error('Image dimensions exceed Viewer resource limits.');
      if ((pixels += size.width * size.height) > 32 * 1024 * 1024) throw Error('Combined image pixels exceed Viewer resource limits.');
      return {...size, name: path.basename(image.canonical), sha256: sha(image.buffer), url: `data:${size.mime};base64,${image.buffer.toString('base64')}`};
    });
    const columns = metadata.columns ?? 1; const rows = metadata.rows ?? 1;
    if (![columns, rows].every(n => Number.isInteger(n) && n >= 1 && n <= 128) || columns * rows > 4096) throw Error('Sprite grid must contain at most 4096 frames.');
    if (images.some(image => image.width % columns || image.height % rows)) throw Error('Image dimensions must divide evenly into the sprite grid.');
    if (!Array.isArray(metadata.animations) || metadata.animations.length > 128) throw Error('Invalid sprite animations.');
    let frameTotal = 0; const names = new Set();
    const animations = metadata.animations.map(a => {
      if (typeof a.name !== 'string' || !a.name || a.name.length > 128 || names.has(a.name) || !Array.isArray(a.frames) || !a.frames.length || (frameTotal += a.frames.length) > 4096) throw Error('Invalid animation name or frame count.');
      names.add(a.name);
      const frames = a.frames.map(frame => {
        const f = typeof frame === 'number' ? {index: frame, duration: 1 / a.fps} : frame;
        const image = images[f.image ?? 0]; if (!image) throw Error('Unknown frame texture.');
        let rect = f.rect;
        if (f.index !== undefined) {
          if (!Number.isInteger(f.index) || f.index < 0 || f.index >= columns * rows) throw Error('Frame index is outside the sprite grid.');
          const w = image.width / columns; const h = image.height / rows; rect = [(f.index % columns) * w, Math.floor(f.index / columns) * h, w, h];
        }
        rect ??= [0, 0, image.width, image.height];
        if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isInteger) || rect[0] < 0 || rect[1] < 0 || rect[2] <= 0 || rect[3] <= 0 || rect[0] + rect[2] > image.width || rect[1] + rect[3] > image.height || !Number.isFinite(f.duration) || f.duration <= 0 || f.duration > 60) throw Error('Invalid animation frame region or duration.');
        return {image: f.image ?? 0, rect, duration: f.duration};
      });
      return {name: a.name, loop: a.loop !== false, frames};
    });
    return {kind, artifact, data: {name: artifact.name, images, columns, rows, animations, initialMode: kind === 'sprite' ? 'sprite' : kind === 'animation' ? 'animation' : 'image'}};
  }
  return [
    {id: 'image', matches: file => rasterExtensions.includes(path.extname(file).toLowerCase()), open: input => open('image', input)},
    {id: 'sprite', matches: file => file.toLowerCase().endsWith('.sprite.json'), open: input => open('sprite', input)},
    {id: 'animation', matches: isAnimationFile, open: input => open('animation', input)},
  ];
}
module.exports = {createAssetPlugins, imageSize};
