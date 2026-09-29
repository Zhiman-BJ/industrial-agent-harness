const crypto = require('node:crypto');

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;

// Raster header parsing follows the repository-owned asset service; this adapter
// applies prompt limits independently of Viewer artifact limits.
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
      if (p + 2 > b.length) break;
      const length = b.readUInt16BE(p); if (length < 2 || p + length > b.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 8) return {width: b.readUInt16BE(p + 5), height: b.readUInt16BE(p + 3), mime: 'image/jpeg'};
      p += length;
    }
  }
  throw Error('Unsupported or malformed PNG, JPEG or WebP image.');
}

function validatePromptImages(images = []) {
  if (!Array.isArray(images) || images.length > MAX_IMAGES) throw Error('Attach up to 4 images.');
  let total = 0, pixels = 0;
  const ids = new Set();
  return images.map(image => {
    if (!image || typeof image.id !== 'string' || !image.id || image.id.length > 100 || ids.has(image.id) || typeof image.name !== 'string' || !image.name || image.name.length > 200) throw Error('Invalid image attachment.');
    ids.add(image.id);
    if (typeof image.dataUrl !== 'string' || image.dataUrl.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 40) throw Error('Each image must be at most 5 MB.');
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
    if (!match) throw Error('Attach PNG, JPEG or WebP images, using inline image data.');
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES || buffer.toString('base64') !== match[2]) throw Error('Invalid or oversized image data.');
    total += buffer.length;
    if (total > MAX_TOTAL_IMAGE_BYTES) throw Error('Attached images must total at most 10 MB.');
    const size = imageSize(buffer);
    if (size.mime !== match[1]) throw Error('Image content does not match its format.');
    if (!size.width || !size.height || size.width > 8192 || size.height > 8192 || (pixels += size.width * size.height) > 32 * 1024 * 1024) throw Error('Image dimensions exceed the attachment limits.');
    return {id: image.id, name: image.name, dataUrl: image.dataUrl, mime: size.mime, width: size.width, height: size.height, sizeBytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex')};
  });
}
function imageContent(text, images, imageInput) {
  if (!images.length) return text;
  if (!imageInput) throw Error('This model is configured for text only. Enable Image input in Model API settings for a model that supports images.');
  return [{type: 'text', text}, ...images.map(image => ({type: 'image_url', image_url: {url: image.dataUrl}}))];
}
module.exports = {validatePromptImages, imageContent, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES};
