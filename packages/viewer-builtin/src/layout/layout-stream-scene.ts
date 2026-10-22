import { projectLayoutVertex } from './layout-scene';
import type { LayoutCamera } from './layout-scene';

export type WorldBox = [number, number, number, number];
export type StreamHit = { layer: string; precision: 'exact' | 'overview' };
export type StreamResource = {
  key: string;
  layer: string;
  box: WorldBox;
  mode: 'exact' | 'overview' | 'empty';
  positions?: Float64Array;
  image?: ImageBitmap;
  mask?: Uint8Array;
  width?: number;
  height?: number;
};
type Mesh = StreamResource & {
  origin: [number, number];
  buffer?: WebGLBuffer;
  texture?: WebGLTexture;
  vertices?: Float32Array;
  count: number;
};
const themes: Record<string, { background: string; colors: string[] }> = {
  '01_neon': {
    background: '05090f',
    colors: [
      '334155',
      '31504c',
      '675181',
      '27d3ff',
      '36e68a',
      'ffd84a',
      'df4cff',
      'ecfaff',
      '243249',
    ],
  },
  '02_blueprint': {
    background: '071421',
    colors: [
      '476682',
      '223d55',
      '40617d',
      '49baff',
      '87d9ff',
      'e1f6ff',
      '6c91ed',
      'ffffff',
      '264663',
    ],
  },
  '03_ember': {
    background: '120d13',
    colors: [
      '544451',
      '4e3541',
      '73556c',
      'ff9855',
      'eac06d',
      'e46c9b',
      'b398fa',
      'fff0d5',
      '3b2a40',
    ],
  },
  '04_routing': {
    background: '080c12',
    colors: [
      '35404f',
      '28313a',
      '3a414d',
      '347087',
      '55cfbf',
      'f0c85b',
      'c38aef',
      'e4f3ff',
      '192431',
    ],
  },
};
const rgb = (hex: string) => [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
function intersect(a: WorldBox, b: WorldBox): WorldBox | null {
  const next: WorldBox = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  return next[2] > next[0] && next[3] > next[1] ? next : null;
}
/** Remove finer coverage from a coarse plane, without inventing boundary walls. */
export function subtractCoverage(rectangles: WorldBox[], cut: WorldBox): WorldBox[] {
  return rectangles.flatMap(rect => {
    const overlap = intersect(rect, cut);
    if (!overlap) return [rect];
    const [l, b, r, t] = rect,
      [cl, cb, cr, ct] = overlap;
    const pieces: WorldBox[] = [];
    if (cl > l) pieces.push([l, b, cl, t]);
    if (cr < r) pieces.push([cr, b, r, t]);
    if (cb > b) pieces.push([cl, b, cr, cb]);
    if (ct < t) pieces.push([cl, ct, cr, t]);
    return pieces;
  });
}

export function createLayoutStreamScene(
  canvas: HTMLCanvasElement,
  world: WorldBox,
  layers: string[],
) {
  const context = canvas.getContext('webgl', {
    alpha: false,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  if (!context) throw Error('3D graphics are unavailable. Return to 2D.');
  const gl: WebGLRenderingContext = context;
  const program = gl.createProgram();
  if (!program) throw Error('Could not initialize the 3D view.');
  const shaders: WebGLShader[] = [];
  const meshes = new Map<string, Mesh>();
  const size = Math.max(world[2] - world[0], world[3] - world[1]);
  const scale = 2 / size,
    cx = (world[0] + world[2]) / 2,
    cy = (world[1] + world[3]) / 2;
  const extent: [number, number] = [(world[2] - world[0]) * scale, (world[3] - world[1]) * scale];
  function shader(type: number, text: string) {
    const item = gl!.createShader(type);
    if (!item) throw Error('Could not initialize the 3D view.');
    shaders.push(item);
    gl!.shaderSource(item, text);
    gl!.compileShader(item);
    if (!gl!.getShaderParameter(item, gl!.COMPILE_STATUS))
      throw Error('Could not initialize the 3D view.');
    gl!.attachShader(program!, item);
  }
  const releaseProgram = () => {
    shaders.forEach(item => gl.deleteShader(item));
    gl.deleteProgram(program);
  };
  try {
    shader(
      gl.VERTEX_SHADER,
      `attribute vec3 position;attribute vec3 normal;attribute vec2 uv;
    uniform vec4 camera;uniform vec4 frame;uniform vec2 layer;uniform vec2 origin;varying float light;varying vec2 texcoord;
    void main(){float cy=cos(camera.x),sy=sin(camera.x),cp=cos(camera.y),sp=sin(camera.y);
    vec3 p=vec3(position.xy+origin,layer.x+position.z*layer.y);vec3 r=vec3(cy*p.x-sy*p.y,sy*p.x+cy*p.y,p.z);
    vec3 v=vec3(r.x,cp*r.y+sp*r.z,sp*r.y-cp*r.z);
    gl_Position=vec4(v.x*camera.z/frame.x+frame.y,v.y*camera.z+frame.z,(sp*(r.y-camera.w)-cp*r.z)*frame.w*.05,1.0);
    vec3 n=vec3(cy*normal.x-sy*normal.y,sy*normal.x+cy*normal.y,normal.z);
    light=.5+.5*abs(dot(normalize(n),normalize(vec3(-.35,-.5,1.))));texcoord=uv;}`,
    );
    shader(
      gl.FRAGMENT_SHADER,
      `precision mediump float;uniform vec3 color;uniform float opacity;uniform float textured;uniform sampler2D mask;
    varying float light;varying vec2 texcoord;void main(){float a=textured>0.5?texture2D(mask,texcoord).r:1.;if(a<.02)discard;
    gl_FragColor=vec4(color*(textured>.5?1.:light),a*opacity);}`,
    );
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw Error('Could not initialize the 3D view.');
  } catch (error) {
    releaseProgram();
    throw error;
  }
  const pos = gl.getAttribLocation(program, 'position'),
    norm = gl.getAttribLocation(program, 'normal'),
    uv = gl.getAttribLocation(program, 'uv');
  const cam = gl.getUniformLocation(program, 'camera'),
    frame = gl.getUniformLocation(program, 'frame'),
    layerLocation = gl.getUniformLocation(program, 'layer'),
    originLocation = gl.getUniformLocation(program, 'origin');
  const colorLocation = gl.getUniformLocation(program, 'color'),
    opacity = gl.getUniformLocation(program, 'opacity'),
    textured = gl.getUniformLocation(program, 'textured');
  const planeBuffer = gl.createBuffer();
  if (!planeBuffer) {
    releaseProgram();
    throw Error('Could not initialize the 3D view.');
  }
  const viewCamera = (camera: LayoutCamera, spacing: number): LayoutCamera => ({
    ...camera,
    depthScale: 1 / camera.zoom,
    depthZoom: camera.zoom,
    depthCenter: 0,
    panX: 0,
    panY: 0,
  });
  function fitScale(camera: LayoutCamera, spacing: number) {
    return camera.view === 'top'
      ? Math.min(2 / extent[1], (2 * (canvas.width / canvas.height)) / extent[0])
      : 1.6 / Math.max(2.85 / Math.min(canvas.width / canvas.height, 1), 2 + 0.65 * spacing);
  }
  function layerHeight(key: string, spacing: number, camera: LayoutCamera) {
    const index = layers.indexOf(key),
      depth = 1 / camera.zoom;
    return [
      layers.length > 1 ? (index / (layers.length - 1) - 0.5) * 0.65 * spacing * depth : 0,
      (0.18 / Math.max(1, layers.length)) * depth,
    ];
  }
  // Subtract the camera focus in double precision before uploading float32 data.
  // A tile far from the layout origin must retain its local DBU-sized features.
  function focus(camera: LayoutCamera, spacing: number): [number, number] {
    const s = fitScale(camera, spacing) * camera.zoom,
      rx = (-camera.panX * (canvas.width / canvas.height)) / s,
      ry = -camera.panY / (Math.cos(camera.pitch) * s),
      yawCos = Math.cos(camera.yaw),
      yawSin = Math.sin(camera.yaw);
    return [(yawCos * rx + yawSin * ry) / scale + cx, (-yawSin * rx + yawCos * ry) / scale + cy];
  }
  function focusAt(camera: LayoutCamera, center: [number, number], spacing: number): LayoutCamera {
    const x = (center[0] - cx) * scale,
      y = (center[1] - cy) * scale,
      s = fitScale(camera, spacing) * camera.zoom,
      yawCos = Math.cos(camera.yaw),
      yawSin = Math.sin(camera.yaw);
    return {
      ...camera,
      panX: -((yawCos * x - yawSin * y) * s) / (canvas.width / canvas.height),
      panY: -Math.cos(camera.pitch) * (yawSin * x + yawCos * y) * s,
    };
  }
  function reframe(
    camera: LayoutCamera,
    patch: Partial<LayoutCamera>,
    spacing: number,
    nextSpacing = spacing,
  ) {
    return focusAt({ ...camera, ...patch }, focus(camera, spacing), nextSpacing);
  }
  function inverse(
    camera: LayoutCamera,
    spacing: number,
    key: string,
    x: number,
    y: number,
    z = 0.5,
  ): [number, number, number] {
    const aspect = canvas.width / canvas.height,
      s = fitScale(camera, spacing) * camera.zoom;
    const [offset, thickness] = layerHeight(key, spacing, camera),
      height = offset + z * thickness;
    const rx = ((x * 2 - 1 - camera.panX) * aspect) / s;
    const ry =
      ((1 - y * 2 - camera.panY) / s - Math.sin(camera.pitch) * height) / Math.cos(camera.pitch);
    const nx = Math.cos(camera.yaw) * rx + Math.sin(camera.yaw) * ry;
    const ny = -Math.sin(camera.yaw) * rx + Math.cos(camera.yaw) * ry;
    return [
      nx / scale + cx,
      ny / scale + cy,
      (Math.sin(camera.pitch) * (ry + camera.panY / (Math.cos(camera.pitch) * s)) -
        Math.cos(camera.pitch) * height) *
        camera.zoom *
        0.05,
    ];
  }
  function remove(key: string) {
    const mesh = meshes.get(key);
    if (!mesh) return;
    if (mesh.buffer) gl!.deleteBuffer(mesh.buffer);
    if (mesh.texture) gl!.deleteTexture(mesh.texture);
    meshes.delete(key);
  }
  function put(resource: StreamResource) {
    remove(resource.key);
    const mesh: Mesh = {
      ...resource,
      count: 0,
      origin: [(resource.box[0] + resource.box[2]) / 2, (resource.box[1] + resource.box[3]) / 2],
    };
    if (resource.mode === 'exact') {
      const source = resource.positions!;
      const vertices = new Float32Array((source.length / 3) * 8);
      for (let i = 0; i < source.length; i += 9) {
        const ux = source[i + 3] - source[i],
          uy = source[i + 4] - source[i + 1],
          uz = source[i + 5] - source[i + 2];
        const vx = source[i + 6] - source[i],
          vy = source[i + 7] - source[i + 1],
          vz = source[i + 8] - source[i + 2];
        const nx = uy * vz - uz * vy,
          ny = uz * vx - ux * vz,
          nz = ux * vy - uy * vx,
          n = Math.hypot(nx, ny, nz) || 1;
        for (let j = 0; j < 9; j += 3)
          vertices.set(
            [
              (source[i + j] - mesh.origin[0]) * scale,
              (source[i + j + 1] - mesh.origin[1]) * scale,
              source[i + j + 2],
              nx / n,
              ny / n,
              nz / n,
              0,
              0,
            ],
            ((i + j) / 3) * 8,
          );
      }
      mesh.buffer = gl.createBuffer()!;
      if (!mesh.buffer) throw Error('Could not initialize the 3D view.');
      mesh.vertices = vertices;
      mesh.count = source.length / 3;
      mesh.positions = undefined;
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    } else if (resource.mode === 'overview') {
      mesh.texture = gl.createTexture()!;
      if (!mesh.texture) throw Error('Could not initialize the 3D view.');
      gl.bindTexture(gl.TEXTURE_2D, mesh.texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, resource.image!);
      resource.image?.close();
      mesh.image = undefined;
    }
    meshes.set(mesh.key, mesh);
    if (gl.getError() !== gl.NO_ERROR) {
      remove(mesh.key);
      throw Error('Could not initialize the 3D view.');
    }
    return mesh.mode === 'exact'
      ? {
          cpuBytes: mesh.vertices!.byteLength,
          gpuBytes: mesh.vertices!.byteLength,
          triangles: mesh.count / 3,
        }
      : {
          cpuBytes: mesh.mask?.byteLength || 0,
          gpuBytes: (mesh.width || 0) * (mesh.height || 0) * 4,
          triangles: 0,
        };
  }
  function activate(buffer: WebGLBuffer) {
    gl!.bindBuffer(gl!.ARRAY_BUFFER, buffer);
    gl!.enableVertexAttribArray(pos);
    gl!.vertexAttribPointer(pos, 3, gl!.FLOAT, false, 32, 0);
    gl!.enableVertexAttribArray(norm);
    gl!.vertexAttribPointer(norm, 3, gl!.FLOAT, false, 32, 12);
    gl!.enableVertexAttribArray(uv);
    gl!.vertexAttribPointer(uv, 2, gl!.FLOAT, false, 32, 24);
  }
  function coverage(mesh: Mesh, active: Set<string>) {
    let result: WorldBox[] = [mesh.box];
    const area = (b: WorldBox) => (b[2] - b[0]) * (b[3] - b[1]);
    for (const other of meshes.values())
      if (
        other.key !== mesh.key &&
        active.has(other.key) &&
        other.layer === mesh.layer &&
        (area(other.box) < area(mesh.box) * 0.999999 ||
          (mesh.key.startsWith('root:') &&
            !other.key.startsWith('root:') &&
            area(other.box) <= area(mesh.box)))
      )
        result = subtractCoverage(result, other.box);
    return result;
  }
  function draw(
    camera: LayoutCamera,
    spacing: number,
    visible: string[],
    theme: string,
    selected: string | null,
    active: Set<string>,
  ) {
    const palette = themes[theme] || themes['02_blueprint'],
      background = rgb(palette.background),
      aspect = canvas.width / canvas.height,
      center = focus(camera, spacing);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(background[0], background[1], background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform4f(cam, camera.yaw, camera.pitch, fitScale(camera, spacing) * camera.zoom, 0);
    gl.uniform4f(frame, aspect, 0, 0, camera.zoom);
    gl.uniform1f(opacity, 1);
    const shown = new Set(visible);
    let triangles = 0,
      overviews = 0;
    const render = (mesh: Mesh) => {
      const [z, h] = layerHeight(mesh.layer, spacing, camera);
      gl!.uniform2f(layerLocation, z, h);
      const index = Number(mesh.layer.split('/')[0]) - 1,
        color = rgb(
          palette.colors[
            ((index % palette.colors.length) + palette.colors.length) % palette.colors.length
          ],
        );
      if (selected)
        for (let i = 0; i < 3; i++)
          color[i] =
            selected === mesh.layer ? color[i] * 0.35 + [1, 0.88, 0.42][i] * 0.65 : color[i] * 0.4;
      gl!.uniform3f(colorLocation, color[0], color[1], color[2]);
      if (mesh.mode === 'exact') {
        gl!.uniform2f(
          originLocation,
          (mesh.origin[0] - center[0]) * scale,
          (mesh.origin[1] - center[1]) * scale,
        );
        gl!.uniform1f(textured, 0);
        activate(mesh.buffer!);
        gl!.drawArrays(gl!.TRIANGLES, 0, mesh.count);
      } else if (mesh.mode === 'overview') {
        gl!.uniform2f(originLocation, 0, 0);
        gl!.uniform1f(textured, 1);
        gl!.bindTexture(gl!.TEXTURE_2D, mesh.texture!);
        const data: number[] = [];
        for (const b of coverage(mesh, active)) {
          const point = (x: number, y: number) => [
            (x - center[0]) * scale,
            (y - center[1]) * scale,
            0.5,
            0,
            0,
            1,
            (x - mesh.box[0]) / (mesh.box[2] - mesh.box[0]),
            (mesh.box[3] - y) / (mesh.box[3] - mesh.box[1]),
          ];
          data.push(
            ...point(b[0], b[1]),
            ...point(b[2], b[1]),
            ...point(b[2], b[3]),
            ...point(b[0], b[1]),
            ...point(b[2], b[3]),
            ...point(b[0], b[3]),
          );
        }
        activate(planeBuffer);
        gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array(data), gl!.DYNAMIC_DRAW);
        gl!.drawArrays(gl!.TRIANGLES, 0, data.length / 8);
      }
    };
    for (const mesh of meshes.values())
      if (active.has(mesh.key) && shown.has(mesh.layer)) {
        render(mesh);
        if (mesh.mode === 'exact') triangles += mesh.count / 3;
        else if (mesh.mode === 'overview') overviews++;
      }
    if (selected && shown.has(selected)) {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.uniform1f(opacity, 0.8);
      for (const mesh of meshes.values())
        if (active.has(mesh.key) && mesh.layer === selected) render(mesh);
    }
    Object.assign(canvas.dataset, {
      zoom: String(camera.zoom),
      yaw: String(camera.yaw),
      pitch: String(camera.pitch),
      panX: String(camera.panX),
      panY: String(camera.panY),
      selectedLayer: selected || '',
      visibleLayers: visible.join(','),
      triangles: String(triangles),
      overviewTiles: String(overviews),
      view: camera.view || 'isometric',
      box: JSON.stringify(world),
    });
  }
  function viewBox(camera: LayoutCamera, spacing: number, visible: string[]): WorldBox {
    const points = visible.flatMap(layer =>
      [
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
      ].map(([x, y]) => inverse(camera, spacing, layer, x, y)),
    );
    if (!points.length) return world;
    return (
      intersect(world, [
        Math.min(...points.map(p => p[0])),
        Math.min(...points.map(p => p[1])),
        Math.max(...points.map(p => p[0])),
        Math.max(...points.map(p => p[1])),
      ]) || world
    );
  }
  function pick(
    camera: LayoutCamera,
    spacing: number,
    visible: string[],
    x: number,
    y: number,
    active: Set<string>,
  ): StreamHit | null {
    const shown = new Set(visible),
      px = x * 2 - 1,
      py = 1 - y * 2,
      vc = viewCamera(camera, spacing),
      center = focus(camera, spacing),
      aspect = canvas.width / canvas.height;
    let hit: StreamHit | null = null,
      depth = Infinity;
    for (const mesh of meshes.values()) {
      if (!active.has(mesh.key) || !shown.has(mesh.layer) || mesh.mode === 'empty') continue;
      if (mesh.mode === 'overview') {
        const [wx, wy, z] = inverse(camera, spacing, mesh.layer, x, y);
        if (!coverage(mesh, active).some(b => wx >= b[0] && wx <= b[2] && wy >= b[1] && wy <= b[3]))
          continue;
        const u = Math.min(
          mesh.width! - 1,
          Math.max(0, Math.floor(((wx - mesh.box[0]) / (mesh.box[2] - mesh.box[0])) * mesh.width!)),
        );
        const v = Math.min(
          mesh.height! - 1,
          Math.max(
            0,
            Math.floor(((mesh.box[3] - wy) / (mesh.box[3] - mesh.box[1])) * mesh.height!),
          ),
        );
        if ((mesh.mask?.[v * mesh.width! + u] || 0) < 5) continue;
        if (z >= -1 && z <= 1 && z < depth) {
          depth = z;
          hit = { layer: mesh.layer, precision: 'overview' };
        }
      } else {
        const values = mesh.vertices!,
          rank = layers.indexOf(mesh.layer);
        for (let i = 0; i + 23 < values.length; i += 24) {
          const project = (j: number) =>
            projectLayoutVertex(
              values[j] + (mesh.origin[0] - center[0]) * scale,
              values[j + 1] + (mesh.origin[1] - center[1]) * scale,
              values[j + 2],
              vc,
              aspect,
              spacing,
              rank,
              layers.length,
              extent,
            );
          const a = project(i),
            b = project(i + 8),
            c = project(i + 16),
            d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
          if (Math.abs(d) < 1e-12) continue;
          const u = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / d,
            v = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / d;
          if (u < 0 || v < 0 || u + v > 1) continue;
          const z = u * a[2] + v * b[2] + (1 - u - v) * c[2];
          if (z >= -1 && z <= 1 && z < depth) {
            depth = z;
            hit = { layer: mesh.layer, precision: 'exact' };
          }
        }
      }
    }
    return hit;
  }
  return {
    put,
    remove,
    draw,
    pick,
    viewBox,
    focus,
    focusAt,
    reframe,
    has: (key: string) => meshes.has(key),
    dispose() {
      for (const key of [...meshes.keys()]) remove(key);
      gl.deleteBuffer(planeBuffer);
      gl.deleteProgram(program);
      shaders.forEach(shader => gl.deleteShader(shader));
    },
  };
}
