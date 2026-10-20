// The upstream 0.0.23 bytes remain unchanged on disk. This narrow adaptation
// lowers the standard WASM memory limit before compilation. It does not bound
// the JavaScript heap or the operating-system process.
export const PCB_STEP_WASM_SHA256 =
  '33391fc9d94ea5c869a6718488bf0a9a464222bac9bdc764dfe1690cef281952';
export const PCB_STEP_WASM_PAGES = 4096; // 256 MiB, 64 KiB pages.

const uleb = value => {
  const output = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value) byte |= 128;
    output.push(byte);
  } while (value);
  return output;
};

export async function boundPcbStepWasm(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength !== 7604031) throw Error('Unexpected STEP parser binary.');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
  if (digest !== PCB_STEP_WASM_SHA256) throw Error('STEP parser integrity check failed.');
  const module = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(module).some(entry => entry.kind === 'memory'))
    throw Error('Unexpected imported STEP parser memory.');
  let cursor = 8;
  const read = end => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      if (cursor >= end) throw Error('Invalid STEP parser section.');
      const byte = bytes[cursor++];
      value += (byte & 127) * 2 ** shift;
      if (value > 0xffffffff) throw Error('Invalid STEP parser section length.');
      if (!(byte & 128)) return value;
    }
    throw Error('Invalid STEP parser integer.');
  };
  let memory;
  while (cursor < bytes.length) {
    const start = cursor;
    const section = bytes[cursor++];
    const length = read(bytes.length);
    const end = cursor + length;
    if (end > bytes.length) throw Error('Invalid STEP parser section length.');
    if (section === 5) {
      if (memory || read(end) !== 1 || read(end) !== 1)
        throw Error('Unexpected STEP parser memory section.');
      const initial = read(end);
      const maximum = read(end);
      if (initial !== 457 || maximum !== 32768 || cursor !== end)
        throw Error('Unexpected STEP parser memory limits.');
      const payload = [1, 1, ...uleb(initial), ...uleb(PCB_STEP_WASM_PAGES)];
      memory = { start, end, section: new Uint8Array([5, ...uleb(payload.length), ...payload]) };
    }
    cursor = end;
  }
  if (!memory) throw Error('STEP parser has no bounded memory.');
  const output = new Uint8Array(bytes.length - (memory.end - memory.start) + memory.section.length);
  output.set(bytes.subarray(0, memory.start));
  output.set(memory.section, memory.start);
  output.set(bytes.subarray(memory.end), memory.start + memory.section.length);
  if (!WebAssembly.validate(output)) throw Error('Invalid bounded STEP parser.');
  return output;
}
