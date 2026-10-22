import type { LayoutGeometry } from '../api';
export interface LayoutCamera {
  zoom: number;
  yaw: number;
  pitch: number;
  panX: number;
  panY: number;
  view?: LayoutViewPreset;
  depthScale?: number;
  depthCenter?: number;
  depthZoom?: number;
}
export const initialCamera = (): LayoutCamera => ({
  zoom: 1,
  yaw: -0.6,
  pitch: 0.85,
  panX: 0,
  panY: 0,
});
export type LayoutViewPreset = 'isometric' | 'top';
export function presetCamera(preset: LayoutViewPreset): LayoutCamera {
  return preset === 'top'
    ? { ...initialCamera(), view: 'top', yaw: 0, pitch: 0 }
    : { ...initialCamera(), view: 'isometric' };
}
function layoutFrame(
  aspect: number,
  spacing: number,
  camera: LayoutCamera,
  extent: [number, number] = [2, 2],
) {
  if (camera.view === 'top') return Math.min(2 / extent[1], (2 * aspect) / extent[0]);
  return 1.6 / Math.max(2.85 / Math.min(aspect, 1), 2 + 0.65 * spacing);
}
function layoutLayer(index: number, count: number, spacing: number) {
  return {
    offset: count > 1 ? (index / (count - 1) - 0.5) * 0.65 * spacing : 0,
    thickness: 0.18 / Math.max(1, count),
  };
}
/** Same orthographic transform as the vertex shader; XY remains layout geometry. */
export function projectLayoutVertex(
  x: number,
  y: number,
  z: number,
  camera: LayoutCamera,
  aspect: number,
  spacing: number,
  layerIndex: number,
  layerCount: number,
  extent?: [number, number],
): [number, number, number] {
  const layer = layoutLayer(layerIndex, layerCount, spacing);
  const cy = Math.cos(camera.yaw),
    sy = Math.sin(camera.yaw);
  const cp = Math.cos(camera.pitch),
    sp = Math.sin(camera.pitch);
  const rx = cy * x - sy * y,
    ry = sy * x + cy * y;
  const height = (layer.offset + z * layer.thickness) * (camera.depthScale ?? 1);
  const scale = layoutFrame(aspect, spacing, camera, extent) * camera.zoom;
  return [
    (rx * scale) / aspect + camera.panX,
    (cp * ry + sp * height) * scale + camera.panY,
    (sp * (ry - (camera.depthCenter ?? 0)) - cp * height) * (camera.depthZoom ?? 1) * 0.05,
  ];
}
export interface PickableLayoutMesh {
  key: string;
  vertices: Float32Array;
}
/** Pick the actual frontmost triangle at a top-left-origin normalized canvas point. */
export function pickLayoutLayer(
  meshes: PickableLayoutMesh[],
  layerKeys: string[],
  camera: LayoutCamera,
  aspect: number,
  spacing: number,
  visible: string[],
  x: number,
  y: number,
  extent?: [number, number],
): string | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  const px = x * 2 - 1,
    py = 1 - y * 2,
    shown = new Set(visible);
  let nearest = Infinity,
    selected: string | null = null;
  for (const mesh of meshes) {
    if (!shown.has(mesh.key)) continue;
    const rank = layerKeys.indexOf(mesh.key);
    if (rank < 0) continue;
    const values = mesh.vertices;
    for (let offset = 0; offset + 17 < values.length; offset += 18) {
      const a = projectLayoutVertex(
        values[offset],
        values[offset + 1],
        values[offset + 2],
        camera,
        aspect,
        spacing,
        rank,
        layerKeys.length,
        extent,
      );
      const b = projectLayoutVertex(
        values[offset + 6],
        values[offset + 7],
        values[offset + 8],
        camera,
        aspect,
        spacing,
        rank,
        layerKeys.length,
        extent,
      );
      const c = projectLayoutVertex(
        values[offset + 12],
        values[offset + 13],
        values[offset + 14],
        camera,
        aspect,
        spacing,
        rank,
        layerKeys.length,
        extent,
      );
      const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(denominator) < 1e-12) continue;
      const u = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / denominator;
      const v = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / denominator;
      if (u < -1e-7 || v < -1e-7 || u + v > 1 + 1e-7) continue;
      const depth = u * a[2] + v * b[2] + (1 - u - v) * c[2];
      if (depth >= -1 && depth <= 1 && depth < nearest) {
        nearest = depth;
        selected = mesh.key;
      }
    }
  }
  return selected;
}
const palettes: Record<string, { background: string; colors: string[] }> = {
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
/** Read-only GPU geometry. Generic extrusion heights are not engineering facts. */
export function createLayoutScene(canvas: HTMLCanvasElement, layerKeys: string[]) {
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw Error('3D graphics are unavailable. Return to 2D.');
  const shaders: WebGLShader[] = [];
  const program = gl.createProgram();
  if (!program) throw Error('Could not initialize the 3D view.');
  let meshes: Array<PickableLayoutMesh & { buffer: WebGLBuffer; count: number }> = [];
  let extent: [number, number] = [2, 2];
  function dispose() {
    for (const mesh of meshes) gl!.deleteBuffer(mesh.buffer);
    meshes = [];
    gl!.deleteProgram(program);
    for (const shader of shaders) gl!.deleteShader(shader);
  }
  function compile(type: number, source: string) {
    const shader = gl!.createShader(type);
    if (!shader) throw Error('Could not initialize the 3D view.');
    shaders.push(shader);
    gl!.shaderSource(shader, source);
    gl!.compileShader(shader);
    if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS))
      throw Error('Could not initialize the 3D view.');
    gl!.attachShader(program!, shader);
  }
  try {
    compile(
      gl.VERTEX_SHADER,
      `
 attribute vec3 position; attribute vec3 normal; uniform vec4 camera; uniform vec4 frame; uniform vec2 layer; varying float light;
 void main(){float cy=cos(camera.x),sy=sin(camera.x),cp=cos(camera.y),sp=sin(camera.y);
 vec3 p=vec3(position.xy,layer.x+position.z*layer.y);vec3 r=vec3(cy*p.x-sy*p.y,sy*p.x+cy*p.y,p.z);
 vec3 v=vec3(r.x,cp*r.y+sp*r.z,sp*r.y-cp*r.z);
 gl_Position=vec4(v.x*camera.z/frame.x+frame.y,v.y*camera.z+frame.z,v.z*0.05,1.0);
 vec3 n=vec3(cy*normal.x-sy*normal.y,sy*normal.x+cy*normal.y,normal.z);
 light=0.50+0.50*abs(dot(normalize(n),normalize(vec3(-0.35,-0.5,1.0))));}`,
    );
    compile(
      gl.FRAGMENT_SHADER,
      `precision mediump float;uniform vec3 color;uniform float opacity;varying float light;void main(){gl_FragColor=vec4(color*light,opacity);}`,
    );
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw Error('Could not initialize the 3D view.');
  } catch (error) {
    dispose();
    throw error;
  }
  const position = gl.getAttribLocation(program, 'position'),
    normal = gl.getAttribLocation(program, 'normal');
  const cameraLocation = gl.getUniformLocation(program, 'camera'),
    frameLocation = gl.getUniformLocation(program, 'frame'),
    layerLocation = gl.getUniformLocation(program, 'layer'),
    colorLocation = gl.getUniformLocation(program, 'color'),
    opacityLocation = gl.getUniformLocation(program, 'opacity');
  return {
    setGeometry(data: LayoutGeometry) {
      for (const mesh of meshes) gl.deleteBuffer(mesh.buffer);
      meshes = [];
      const [left, bottom, right, top] = data.box,
        scale = 2 / Math.max(right - left, top - bottom, 0.000001),
        cx = (left + right) / 2,
        cy = (bottom + top) / 2;
      extent = [(right - left) * scale, (top - bottom) * scale];
      canvas.dataset.box = JSON.stringify(data.box);
      canvas.dataset.geometryLayers = data.layers.map(layer => layer.key).join(',');
      try {
        for (const item of data.layers) {
          const source = item.triangles,
            values = new Float32Array(source.length * 2);
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
              length = Math.hypot(nx, ny, nz) || 1;
            for (let j = 0; j < 9; j += 3)
              values.set(
                [
                  (source[i + j] - cx) * scale,
                  (source[i + j + 1] - cy) * scale,
                  source[i + j + 2],
                  nx / length,
                  ny / length,
                  nz / length,
                ],
                (i + j) * 2,
              );
          }
          const buffer = gl.createBuffer();
          if (!buffer) throw Error('Could not initialize the 3D view.');
          meshes.push({ key: item.key, buffer, count: source.length / 3, vertices: values });
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
          gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW);
        }
        if (gl.getError() !== gl.NO_ERROR) throw Error('Could not initialize the 3D view.');
      } catch (error) {
        for (const mesh of meshes) gl.deleteBuffer(mesh.buffer);
        meshes = [];
        throw error;
      }
    },
    draw(
      camera: LayoutCamera,
      spacing: number,
      visible: string[],
      theme: string,
      selectedLayer: string | null = null,
    ) {
      const palette = palettes[theme] || palettes['02_blueprint'],
        background = rgb(palette.background);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(background[0], background[1], background[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(program);
      gl.uniform1f(opacityLocation, 1);
      const aspect = canvas.width / canvas.height,
        fitScale = layoutFrame(aspect, spacing, camera, extent);
      gl.uniform4f(cameraLocation, camera.yaw, camera.pitch, fitScale * camera.zoom, 0);
      gl.uniform4f(frameLocation, aspect, camera.panX, camera.panY, 0);
      const shown = new Set(visible);
      let triangles = 0;
      const drawMesh = (mesh: (typeof meshes)[number]) => {
        const layer = layoutLayer(layerKeys.indexOf(mesh.key), layerKeys.length, spacing);
        gl.uniform2f(layerLocation, layer.offset, layer.thickness);
        const layerNumber = Number(mesh.key.split('/')[0]),
          color = rgb(
            palette.colors[
              (((layerNumber - 1) % palette.colors.length) + palette.colors.length) %
                palette.colors.length
            ],
          );
        if (selectedLayer) {
          for (let i = 0; i < 3; i++)
            color[i] =
              mesh.key === selectedLayer
                ? color[i] * 0.35 + [1, 0.88, 0.42][i] * 0.65
                : color[i] * 0.4;
        }
        gl.uniform3f(colorLocation, color[0], color[1], color[2]);
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(normal);
        gl.vertexAttribPointer(normal, 3, gl.FLOAT, false, 24, 12);
        gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
      };
      for (const mesh of meshes) {
        if (!shown.has(mesh.key)) continue;
        drawMesh(mesh);
        triangles += mesh.count / 3;
      }
      // Explicit selection overlay reveals the selected geometry through other
      // layers. Its own depth still applies; picking uses ordinary layer depth.
      const selected = meshes.find(mesh => mesh.key === selectedLayer && shown.has(mesh.key));
      if (selected) {
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.uniform1f(opacityLocation, 0.8);
        drawMesh(selected);
        gl.disable(gl.BLEND);
      }
      Object.assign(canvas.dataset, {
        zoom: String(camera.zoom),
        yaw: String(camera.yaw),
        pitch: String(camera.pitch),
        panX: String(camera.panX),
        panY: String(camera.panY),
        visibleLayers: visible.join(','),
        selectedLayer: selectedLayer || '',
        view: camera.view || 'isometric',
        triangles: String(triangles),
      });
    },
    pick(camera: LayoutCamera, spacing: number, visible: string[], x: number, y: number) {
      return pickLayoutLayer(
        meshes,
        layerKeys,
        camera,
        canvas.width / canvas.height,
        spacing,
        visible,
        x,
        y,
        extent,
      );
    },
    dispose,
  };
}
