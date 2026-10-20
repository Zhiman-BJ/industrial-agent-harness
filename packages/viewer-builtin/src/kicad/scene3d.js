import * as THREE from './three/three.module.js';
import { OrbitControls } from './three/controls/OrbitControls.js';

// The input is display geometry captured by the pinned KiCanvas painter. These
// budgets apply to rendered detail, never to the source board or engineering
// verification. The host receives explicit counts for any omitted geometry.
const MAX_TRIANGLES = 1200000;
const MAX_BODY_HOLES = 3000;
const MAX_PICK_TARGETS = 200000;
const MAX_DRILL_MASK_POINTS = 300000;
const MAX_PRIMITIVE_POINTS = 32000;
// The real KiCad video board contains a 61,127-point bridged copper pour.
// Keep it intact while bounding each synchronous Earcut call and its output.
const MAX_POLYGON_POINTS = 65536;
const MAX_BODY_POINTS = 32000;
const MAX_TOPOLOGY_OPERATIONS = 8000000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const xy = point => Array.isArray(point) && finite(point[0]) && finite(point[1]);
const yieldFrame = () => new Promise(resolve => setTimeout(resolve, 0));
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const circleSteps = radius => {
  const steps = Math.max(12, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - 0.01 / radius))));
  return steps <= 4096 ? steps : 0;
};

class TopologyBudgetError extends Error {}
function spendTopology(budget) {
  if (budget && --budget.remaining < 0) throw new TopologyBudgetError();
}

function inside(point, polygon, budget) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    spendTopology(budget);
    const a = polygon[i],
      b = polygon[j];
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      result = !result;
  }
  return result;
}

function drillPointCount(hole) {
  if (
    !xy(hole.center) ||
    !xy(hole.size) ||
    Math.min(...hole.size) <= 0 ||
    (hole.rotation !== undefined && !finite(hole.rotation))
  )
    return 0;
  const steps = circleSteps(Math.min(...hole.size) / 2);
  if (!steps) return 0;
  return hole.size[0] === hole.size[1] ? steps + 1 : 2 * Math.ceil(steps / 2) + 3;
}

function drillContour(hole) {
  if (!drillPointCount(hole)) return [];
  const [width, height] = hole.size,
    radius = Math.min(width, height) / 2;
  const horizontal = width >= height,
    half = Math.abs(width - height) / 2;
  const rotation = ((finite(hole.rotation) ? hole.rotation : 0) * Math.PI) / 180;
  const points = [];
  const steps = circleSteps(radius);
  const add = (x, y) => {
    points.push([
      hole.center[0] + x * Math.cos(rotation) - y * Math.sin(rotation),
      hole.center[1] + x * Math.sin(rotation) + y * Math.cos(rotation),
    ]);
  };
  if (!half) {
    for (let i = 0; i < steps; i++) {
      const angle = (i * Math.PI * 2) / steps;
      add(Math.cos(angle) * radius, Math.sin(angle) * radius);
    }
  } else {
    // Each semicircle includes both tangent endpoints. Sampling one circle and
    // shifting by the sign of x/y would diagonally cut off the slot's straight
    // sides whenever an endpoint falls between samples.
    const halfSteps = Math.ceil(steps / 2);
    for (let cap = 0; cap < 2; cap++) {
      const start = horizontal ? -Math.PI / 2 + cap * Math.PI : cap * Math.PI;
      for (let i = 0; i <= halfSteps; i++) {
        const angle = start + (i * Math.PI) / halfSteps;
        add(
          Math.cos(angle) * radius + (horizontal ? (cap ? -half : half) : 0),
          Math.sin(angle) * radius + (horizontal ? 0 : cap ? -half : half),
        );
      }
    }
  }
  points.push([...points[0]]);
  return points;
}

function pathFrom(points) {
  const path = new THREE.Path();
  points.forEach(([x, y], index) => (index ? path.lineTo(x, -y) : path.moveTo(x, -y)));
  path.closePath();
  return path;
}

function intersects(a, b, budget) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) {
      spendTopology(budget);
      const p = a[i],
        q = a[(i + 1) % a.length],
        r = b[j],
        s = b[(j + 1) % b.length];
      if ((p[0] === q[0] && p[1] === q[1]) || (r[0] === s[0] && r[1] === s[1])) continue;
      if (
        Math.max(p[0], q[0]) < Math.min(r[0], s[0]) ||
        Math.max(r[0], s[0]) < Math.min(p[0], q[0]) ||
        Math.max(p[1], q[1]) < Math.min(r[1], s[1]) ||
        Math.max(r[1], s[1]) < Math.min(p[1], q[1])
      )
        continue;
      if (cross(p, q, r) * cross(p, q, s) <= 0 && cross(r, s, p) * cross(r, s, q) <= 0) return true;
    }
  return false;
}

function isThroughHole(hole, layers) {
  const names = [hole.startLayer, hole.endLayer].map(
    value => layers.find(layer => layer.id === value)?.name || String(value || ''),
  );
  return names.includes('F.Cu') && names.includes('B.Cu');
}

function containedBoardHoles(outline, candidates, cellSize, budget) {
  const selected = candidates.filter(
    hole => hole.some(point => inside(point, outline, budget)) || intersects(hole, outline, budget),
  );
  // Earcut needs contained, disjoint holes; it is not a boolean clipping engine.
  if (
    selected.some(
      hole =>
        !hole.every(point => inside(point, outline, budget)) || intersects(hole, outline, budget),
    )
  )
    return null;
  const cells = new Map();
  for (let i = 0; i < selected.length; i++) {
    const hole = selected[i];
    const minX = Math.floor(Math.min(...hole.map(point => point[0])) / cellSize);
    const maxX = Math.floor(Math.max(...hole.map(point => point[0])) / cellSize);
    const minY = Math.floor(Math.min(...hole.map(point => point[1])) / cellSize);
    const maxY = Math.floor(Math.max(...hole.map(point => point[1])) / cellSize);
    if ((maxX - minX + 1) * (maxY - minY + 1) > 5000) throw new TopologyBudgetError();
    const previous = new Set();
    for (let x = minX; x <= maxX; x++)
      for (let y = minY; y <= maxY; y++) {
        spendTopology(budget);
        const key = `${x}:${y}`,
          entries = cells.get(key) || [];
        for (const other of entries) {
          spendTopology(budget);
          previous.add(other);
        }
        entries.push(i);
        cells.set(key, entries);
      }
    for (const j of previous)
      if (
        intersects(hole, selected[j], budget) ||
        inside(hole[0], selected[j], budget) ||
        inside(selected[j][0], hole, budget)
      )
        return null;
  }
  return selected;
}

export function buildPcbSubstrate(input, thickness, layerNames, materials, geometries, counters) {
  const front = layerNames.find(layer => layer.name === 'F.Cu');
  const back = layerNames.find(layer => layer.name === 'B.Cu');
  const top = finite(front?.z)
    ? front.z - (finite(front.thickness) ? front.thickness / 2 : 0.00001)
    : thickness / 2;
  const bottom = finite(back?.z)
    ? back.z + (finite(back.thickness) ? back.thickness / 2 : 0.00001)
    : -thickness / 2;
  const bodyDepth = top - bottom;
  if (!(bodyDepth > 0)) {
    counters.omittedBoardBodies++;
    counters.boardTopologyIncomplete = true;
    return new THREE.Group();
  }
  const outlines = input.board.outline || [];
  let outlinePoints = 0;
  for (const ring of outlines) {
    if (!Array.isArray(ring.points) || ring.points.length < 3) {
      counters.omittedBoardBodies = outlines.filter(item => !item.hole).length;
      counters.boardTopologyIncomplete = true;
      return new THREE.Group();
    }
    outlinePoints += ring.points.length;
    if (outlinePoints > MAX_BODY_POINTS) {
      counters.omittedBoardBodies = outlines.filter(item => !item.hole).length;
      counters.bodyComplexityLimited = true;
      return new THREE.Group();
    }
  }
  if (outlines.some(ring => !ring.points.every(xy))) {
    counters.omittedBoardBodies = outlines.filter(item => !item.hole).length;
    counters.boardTopologyIncomplete = true;
    return new THREE.Group();
  }
  const holes = (input.holes || []).filter(hole => isThroughHole(hole, layerNames));
  const internalDrills = (input.holes || []).length - holes.length;
  if (internalDrills) {
    counters.unmodeledDrillCavities = internalDrills;
    counters.omittedBoardBodies = outlines.filter(ring => !ring.hole).length;
    return new THREE.Group();
  }
  let allPoints = outlinePoints;
  let bodyLimited = holes.length > MAX_BODY_HOLES || allPoints > MAX_BODY_POINTS;
  for (const hole of holes) {
    const points = drillPointCount(hole);
    if (!points || (allPoints += points) > MAX_BODY_POINTS) {
      bodyLimited = true;
      break;
    }
  }
  if (bodyLimited) {
    counters.omittedBoardBodies = outlines.filter(ring => !ring.hole).length;
    counters.omittedBodyHoles = holes.length > MAX_BODY_HOLES ? holes.length : 0;
    counters.bodyComplexityLimited = true;
    return new THREE.Group();
  }
  const contours = outlines.filter(ring => ring.hole).map(ring => ring.points);
  const seen = new Set();
  let invalidDrills = 0;
  const bodyDrills = holes
    .slice(0, MAX_BODY_HOLES)
    .map(drillContour)
    .filter(ring => {
      if (!ring.length) {
        invalidDrills++;
        return false;
      }
      const key = JSON.stringify(ring);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  counters.omittedBodyHoles = 0;
  const group = new THREE.Group();
  if (invalidDrills) {
    counters.omittedBoardBodies = outlines.filter(ring => !ring.hole).length;
    counters.bodyComplexityLimited = true;
    return group;
  }
  const outerRings = outlines.filter(item => !item.hole);
  const topologyBudget = { remaining: MAX_TOPOLOGY_OPERATIONS };
  for (let ringIndex = 0; ringIndex < outerRings.length; ringIndex++) {
    const ring = outerRings[ringIndex];
    let selectedHoles;
    try {
      selectedHoles = containedBoardHoles(
        ring.points,
        [...contours, ...bodyDrills],
        Math.max(1, thickness * 2),
        topologyBudget,
      );
    } catch (error) {
      if (!(error instanceof TopologyBudgetError)) throw error;
      counters.omittedBoardBodies += outerRings.length - ringIndex;
      counters.bodyComplexityLimited = true;
      break;
    }
    if (!selectedHoles) {
      counters.omittedBoardBodies++;
      counters.boardTopologyIncomplete = true;
      continue;
    }
    const vertexUpperBound =
      ring.points.length + selectedHoles.reduce((n, hole) => n + hole.length, 0);
    // ExtrudeGeometry has two triangulated caps plus two side triangles per
    // edge. Retaining closed endpoints in this count makes the bound cautious.
    const triangleUpperBound = Math.max(0, vertexUpperBound * 4 + selectedHoles.length * 4 - 4);
    if (
      vertexUpperBound > MAX_BODY_POINTS ||
      counters.triangles + triangleUpperBound > MAX_TRIANGLES
    ) {
      counters.omittedBoardBodies++;
      counters.bodyComplexityLimited = true;
      continue;
    }
    const shape = new THREE.Shape();
    ring.points.forEach(([x, y], index) => (index ? shape.lineTo(x, -y) : shape.moveTo(x, -y)));
    shape.closePath();
    for (const hole of selectedHoles) shape.holes.push(pathFrom(hole));
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: bodyDepth,
      bevelEnabled: false,
      steps: 1,
      curveSegments: 8,
    });
    const triangles = (geometry.index?.count || geometry.attributes.position.count) / 3;
    if (counters.triangles + triangles > MAX_TRIANGLES) {
      geometry.dispose();
      counters.omittedBoardBodies++;
      continue;
    }
    geometry.translate(0, 0, bottom);
    geometries.add(geometry);
    counters.triangles += triangles;
    const material = new THREE.MeshStandardMaterial({
      color: 0x184b3b,
      roughness: 0.82,
      metalness: 0.03,
      side: THREE.DoubleSide,
    });
    materials.add(material);
    group.add(new THREE.Mesh(geometry, material));
  }
  counters.topologyOperations = MAX_TOPOLOGY_OPERATIONS - topologyBudget.remaining;
  return group;
}

function subtractDrill(shape, hole, budget) {
  const contour = drillContour(hole);
  if (!contour.length) return shape;
  let outer,
    holes = shape.holes || [];
  if (shape.kind === 'circle' && xy(shape.center) && finite(shape.radius)) {
    const stroke = finite(shape.width) && shape.width > 0;
    const inner = stroke ? Math.max(0, shape.radius - shape.width / 2) : 0;
    const outerRadius = stroke ? shape.radius + shape.width / 2 : shape.radius;
    const ring = radius =>
      Array.from({ length: circleSteps(radius) }, (_, index) => {
        const angle = (index * Math.PI * 2) / circleSteps(radius);
        return [
          shape.center[0] + Math.cos(angle) * radius,
          shape.center[1] + Math.sin(angle) * radius,
        ];
      });
    outer = ring(outerRadius);
    if (inner > 0) {
      // A painter annulus can already contain this drill opening.
      if (
        contour.every(
          point =>
            Math.hypot(point[0] - shape.center[0], point[1] - shape.center[1]) <= inner * 1.000001,
        )
      )
        return shape;
      holes = [...holes, ring(inner)];
    }
  } else if (shape.kind === 'polygon') outer = shape.points;
  else return shape;
  if (!Array.isArray(outer) || !outer.length) return shape;
  if (holes.some(ring => contour.every(point => inside(point, ring, budget)))) return shape;
  // Unsupported edge-intersecting drilled copper is omitted and counted instead
  // of being displayed as a closed pad or an invented boolean result.
  if (!contour.every(point => inside(point, outer, budget)) || intersects(contour, outer, budget))
    return null;
  return { ...shape, kind: 'polygon', points: outer, holes: [...holes, contour] };
}

// Triangulate the exact painter path, retaining repeated bridge points used by
// KiCad filled polygons to represent holes. Do not convex-hull or deduplicate it.
export function primitiveTriangleBudget(shape) {
  if (shape.kind === 'circle') {
    if (!xy(shape.center) || !finite(shape.radius) || shape.radius <= 0) return null;
    const outer =
      finite(shape.width) && shape.width > 0 ? shape.radius + shape.width / 2 : shape.radius;
    const steps = circleSteps(outer);
    if (!steps) return Infinity;
    const inner =
      finite(shape.width) && shape.width > 0 ? Math.max(0, shape.radius - shape.width / 2) : 0;
    return steps * (inner ? 2 : 1);
  }
  if (shape.kind === 'line') {
    if (!Array.isArray(shape.points) || !finite(shape.width) || shape.width <= 0) return null;
    if (shape.points.length > MAX_PRIMITIVE_POINTS) return Infinity;
    if (!shape.points.every(xy)) return null;
    const steps = circleSteps(shape.width / 2);
    if (!steps) return Infinity;
    return Math.max(0, shape.points.length - 1) * 2 + shape.points.length * steps;
  }
  if (shape.kind === 'polygon') {
    if (
      !Array.isArray(shape.points) ||
      shape.points.length < 3 ||
      (shape.holes && !Array.isArray(shape.holes))
    )
      return null;
    let points = shape.points.length;
    if (points > MAX_POLYGON_POINTS || (shape.holes?.length || 0) > MAX_POLYGON_POINTS / 3)
      return Infinity;
    for (const hole of shape.holes || []) {
      if (!Array.isArray(hole) || hole.length < 3) return null;
      points += hole.length;
      if (points > MAX_POLYGON_POINTS) return Infinity;
      if (!hole.every(xy)) return null;
    }
    if (!shape.points.every(xy)) return null;
    return points + (shape.holes?.length || 0) * 2 - 2;
  }
  return null;
}

function triangulate(shape, z) {
  const positions = [];
  const triangle = (a, b, c) => {
    positions.push(a[0], -a[1], z, b[0], -b[1], z, c[0], -c[1], z);
  };
  const circle = (center, radius, width) => {
    if (!xy(center) || !finite(radius) || radius <= 0) return;
    const inner = finite(width) && width > 0 ? Math.max(0, radius - width / 2) : 0;
    const outer = finite(width) && width > 0 ? radius + width / 2 : radius;
    const steps = circleSteps(outer);
    if (!steps) return;
    for (let i = 0; i < steps; i++) {
      const a = (i * 2 * Math.PI) / steps,
        b = ((i + 1) * 2 * Math.PI) / steps;
      const pa = [center[0] + Math.cos(a) * outer, center[1] + Math.sin(a) * outer];
      const pb = [center[0] + Math.cos(b) * outer, center[1] + Math.sin(b) * outer];
      if (!inner) triangle(center, pa, pb);
      else {
        const ia = [center[0] + Math.cos(a) * inner, center[1] + Math.sin(a) * inner];
        const ib = [center[0] + Math.cos(b) * inner, center[1] + Math.sin(b) * inner];
        triangle(ia, pa, pb);
        triangle(ia, pb, ib);
      }
    }
  };
  if (shape.kind === 'circle') circle(shape.center, shape.radius, shape.width);
  else if (
    shape.kind === 'line' &&
    Array.isArray(shape.points) &&
    finite(shape.width) &&
    shape.width > 0
  ) {
    const points = shape.points;
    if (!points.every(xy)) return positions;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!length) continue;
      const dx = ((-(b[1] - a[1]) / length) * shape.width) / 2;
      const dy = (((b[0] - a[0]) / length) * shape.width) / 2;
      const a1 = [a[0] + dx, a[1] + dy],
        a2 = [a[0] - dx, a[1] - dy];
      const b1 = [b[0] + dx, b[1] + dy],
        b2 = [b[0] - dx, b[1] - dy];
      triangle(a1, a2, b1);
      triangle(a2, b2, b1);
    }
    for (const point of points) circle(point, shape.width / 2);
  } else if (shape.kind === 'polygon' && Array.isArray(shape.points) && shape.points.length >= 3) {
    if (!shape.points.every(xy)) return positions;
    const contour = shape.points.map(([x, y]) => new THREE.Vector2(x, y));
    const holes = (shape.holes || []).map(ring => ring.map(([x, y]) => new THREE.Vector2(x, y)));
    const faces = THREE.ShapeUtils.triangulateShape(contour, holes);
    const points = [...contour, ...holes.flat()];
    for (const face of faces) triangle(...face.map(index => points[index].toArray()));
  }
  return positions;
}

export function buildPcbPrimitive(shape, z, triangleBudget) {
  const budget = finite(triangleBudget)
    ? Math.max(0, Math.min(MAX_TRIANGLES, Math.floor(triangleBudget)))
    : 0;
  const upperBound = primitiveTriangleBudget(shape);
  if (upperBound === null)
    return { complete: false, reason: 'unsupported', positions: [], triangles: 0 };
  if (upperBound > budget)
    return { complete: false, reason: 'budget', positions: [], triangles: 0 };
  const positions = triangulate(shape, z);
  const triangles = positions.length / 9;
  if (!triangles || !Number.isInteger(triangles) || triangles > upperBound || triangles > budget)
    return { complete: false, reason: 'unsupported', positions: [], triangles: 0 };
  return { complete: true, positions, triangles };
}

// A partially built stencil would close the remaining real drill holes. Return
// no mask at all on a limit or unsupported drill so its entire copper layer can
// be omitted explicitly. Check each circle's point/triangle upper bound before
// allocating its contour or triangulating it, and retain bounded typed chunks.
export async function buildDrillMask(holes, copperLayers, layerId, z, triangleBudget, signal) {
  const checkCancelled = () => {
    if (signal?.aborted) throw new DOMException('PCB 3D view closed.', 'AbortError');
  };
  checkCancelled();
  const layerIndex = copperLayers.findIndex(layer => layer.id === layerId);
  if (layerIndex < 0)
    return { complete: true, positions: new Float32Array(), contours: [], triangles: 0 };
  const budget = finite(triangleBudget)
    ? Math.max(0, Math.min(MAX_TRIANGLES, Math.floor(triangleBudget)))
    : 0;
  const layerIndices = new Map();
  copperLayers.forEach((layer, index) => {
    layerIndices.set(layer.id, index);
    layerIndices.set(layer.name, index);
  });
  const contours = [],
    chunks = [];
  let triangles = 0,
    points = 0,
    sinceYield = 0,
    lastYield = performance.now();
  const reject = reason => ({
    complete: false,
    reason,
    positions: new Float32Array(),
    contours: [],
    triangles: 0,
  });
  for (const hole of holes) {
    checkCancelled();
    if (++sinceYield >= 64 || performance.now() - lastYield >= 8) {
      sinceYield = 0;
      await yieldFrame();
      checkCancelled();
      lastYield = performance.now();
    }
    const start = layerIndices.get(hole.startLayer),
      end = layerIndices.get(hole.endLayer);
    if (start === undefined || end === undefined) return reject('unsupported');
    if (layerIndex < Math.min(start, end) || layerIndex > Math.max(start, end)) continue;
    const pointCount = drillPointCount(hole);
    if (!pointCount) return reject('unsupported');
    const triangleUpperBound = pointCount - 3;
    if (triangles + triangleUpperBound > budget || points + pointCount > MAX_DRILL_MASK_POINTS)
      return reject('budget');
    const contour = drillContour(hole);
    const positions = triangulate({ kind: 'polygon', points: contour }, z);
    const added = positions.length / 9;
    if (!added || !Number.isInteger(added) || added > triangleUpperBound)
      return reject('unsupported');
    if (triangles + added > budget) return reject('budget');
    chunks.push(new Float32Array(positions));
    contours.push(contour);
    triangles += added;
    points += contour.length;
  }
  checkCancelled();
  const positions = new Float32Array(triangles * 9);
  let offset = 0;
  for (const chunk of chunks) {
    positions.set(chunk, offset);
    offset += chunk.length;
    if (++sinceYield >= 64 || performance.now() - lastYield >= 8) {
      sinceYield = 0;
      await yieldFrame();
      checkCancelled();
      lastYield = performance.now();
    }
  }
  return { complete: true, positions, contours, triangles };
}

export async function createPcbScene(container, input, callbacks = {}) {
  if (input?.version !== 1 || input.units !== 'mm' || !Array.isArray(input.layers))
    throw Error('Unsupported PCB 3D geometry.');
  const { signal } = callbacks;
  const checkCancelled = () => {
    if (signal?.aborted) throw new DOMException('PCB 3D view closed.', 'AbortError');
  };
  checkCancelled();
  const started = performance.now(),
    sceneId = crypto.randomUUID();
  let builtAt;
  const materials = new Set(),
    geometries = new Set(),
    layers = new Map();
  const objectMap = new Map((input.objects || []).map(object => [object.id, object]));
  const drills = new Map();
  for (const hole of input.holes || []) {
    const values = drills.get(hole.objectId) || [];
    values.push(hole);
    drills.set(hole.objectId, values);
  }
  const counters = {
    triangles: 0,
    renderedPrimitives: 0,
    omittedPrimitives: 0,
    omittedBodyHoles: 0,
    omittedBoardBodies: 0,
    unsupportedPrimitives: 0,
    boardTopologyIncomplete: false,
  };
  let renderer,
    controls,
    observer,
    raf = 0,
    disposed = false,
    lost = false;
  let selectedId = null,
    selectedNet = null,
    explode = 0,
    fitDistance = 1;
  let visibleLayers = new Set(input.layers.map(layer => layer.id));
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(38, 1, 0.01, 10000);
  camera.up.set(0, 0, 1);
  const content = new THREE.Group();
  const boardMeshes = [];
  scene.add(content);
  const highlight = new THREE.Group();
  scene.add(highlight);
  const target = new THREE.Vector3(),
    raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const size = new THREE.Vector3(),
    center = new THREE.Vector3();
  let radius = 1,
    modelSpan = 1;
  const shapeBounds = new THREE.Box2();
  for (const layer of input.layers)
    for (const shape of layer.shapes || []) {
      for (const point of shape.points || [])
        if (xy(point)) shapeBounds.expandByPoint(new THREE.Vector2(...point));
      if (xy(shape.center) && finite(shape.radius)) {
        shapeBounds.expandByPoint(
          new THREE.Vector2(shape.center[0] - shape.radius, shape.center[1] - shape.radius),
        );
        shapeBounds.expandByPoint(
          new THREE.Vector2(shape.center[0] + shape.radius, shape.center[1] + shape.radius),
        );
      }
    }
  for (const ring of input.board.outline || [])
    for (const point of ring.points || [])
      if (xy(point)) shapeBounds.expandByPoint(new THREE.Vector2(...point));
  if (!shapeBounds.isEmpty())
    modelSpan = Math.max(shapeBounds.getSize(new THREE.Vector2()).length(), 1);
  // Unknown thickness gets a scale-relative display depth, with zMode retained
  // as schematic. This value is never returned as a board measurement.
  const thickness =
    finite(input.board.thickness) && input.board.thickness > 0
      ? input.board.thickness
      : modelSpan / 100;
  const copperLayers = input.layers.filter(layer => /\.Cu$/.test(layer.name));
  const order = layer =>
    layer.name === 'F.SilkS'
      ? -2
      : layer.name === 'F.Cu'
        ? -1
        : layer.name === 'B.Cu'
          ? 1000
          : layer.name === 'B.SilkS'
            ? 1001
            : Number(/^In(\d+)\.Cu$/.exec(layer.name)?.[1] ?? 500);
  const renderLayers = input.layers
    .filter(layer => /\.(Cu|SilkS)$/.test(layer.name))
    .sort((a, b) => order(a) - order(b));
  const copperOrder = [...copperLayers].sort((a, b) => order(a) - order(b));
  const layerRank = layer => {
    if (layer.name === 'F.SilkS') return (copperOrder.length - 1) / 2 + 1;
    if (layer.name === 'B.SilkS') return -(copperOrder.length - 1) / 2 - 1;
    return (copperOrder.length - 1) / 2 - copperOrder.findIndex(item => item.id === layer.id);
  };
  const schematicSpacing = thickness / Math.max(1, copperOrder.length - 1);
  const layerZ = layer => {
    if (finite(layer.z)) return layer.z;
    if (layer.name === 'F.SilkS') return thickness / 2 + modelSpan / 10000;
    if (layer.name === 'B.SilkS') return -thickness / 2 - modelSpan / 10000;
    return layerRank(layer) * schematicSpacing;
  };
  const stats = () => ({
    ...counters,
    sourcePrimitives: input.stats?.totalPrimitives ?? input.stats?.primitives ?? 0,
    sourceOmittedPrimitives: input.stats?.omittedPrimitives || 0,
    drawCalls: renderer?.info.render.calls || 0,
    geometryBytes: [...geometries].reduce(
      (total, geometry) =>
        total +
        Object.values(geometry.attributes).reduce(
          (n, attribute) => n + attribute.array.byteLength,
          0,
        ) +
        (geometry.index?.array.byteLength || 0),
      0,
    ),
    buildMs: Math.round((builtAt || performance.now()) - started),
    zMode: input.board.zMode,
  });
  const percent = () =>
    Math.round((fitDistance / Math.max(0.0001, camera.position.distanceTo(controls.target))) * 100);
  const diagnostics = () => {
    const values = {
      pcb3dReady: String(!disposed && !lost),
      pcb3dPercent: String(percent()),
      pcb3dSelected: selectedId || '',
      pcb3dVisibleLayers: JSON.stringify([...visibleLayers]),
      pcb3dExplode: String(explode),
      pcb3dTriangles: String(counters.triangles),
      pcb3dDrawCalls: String(renderer.info.render.calls),
      pcb3dSceneId: sceneId,
    };
    Object.assign(container.dataset, values);
    Object.assign(renderer.domElement.dataset, values);
  };
  const draw = () => {
    raf = 0;
    if (
      disposed ||
      lost ||
      !container.isConnected ||
      !container.clientWidth ||
      !container.clientHeight
    )
      return;
    renderer.render(scene, camera);
    diagnostics();
    callbacks.onView?.({ percent: percent(), stats: stats() });
  };
  const requestDraw = () => {
    if (!disposed && !lost && !raf) raf = requestAnimationFrame(draw);
  };
  const clearHighlight = () => {
    for (const child of [...highlight.children]) {
      if (!child.userData.sharedGeometry) child.geometry.dispose();
      highlight.remove(child);
    }
  };
  const highlightMaterial = new THREE.MeshBasicMaterial({
    color: 0xffe08a,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -100,
  });
  materials.add(highlightMaterial);
  const highlightCopperMaterial = highlightMaterial.clone();
  highlightCopperMaterial.stencilWrite = true;
  highlightCopperMaterial.stencilRef = 1;
  highlightCopperMaterial.stencilFunc = THREE.NotEqualStencilFunc;
  materials.add(highlightCopperMaterial);
  const stencilMaterial = new THREE.MeshBasicMaterial({
    side: THREE.DoubleSide,
    colorWrite: false,
    depthWrite: false,
    depthTest: false,
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilFail: THREE.ReplaceStencilOp,
    stencilZFail: THREE.ReplaceStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
  });
  materials.add(stencilMaterial);
  const updateHighlight = () => {
    clearHighlight();
    if (!selectedId) return;
    for (const layer of layers.values()) {
      if (!layer.mesh.visible) continue;
      const selected = [];
      const source = layer.mesh.geometry.attributes.position.array;
      for (const range of layer.ranges) {
        const object = objectMap.get(range.id);
        if (
          selectedNet !== null
            ? range.net !== selectedNet
            : range.id !== selectedId && object?.footprintId !== selectedId
        )
          continue;
        for (let index = range.start * 9; index < (range.start + range.count) * 9; index++)
          selected.push(source[index]);
      }
      if (!selected.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(selected, 3));
      if (layer.maskMesh) {
        const mask = new THREE.Mesh(layer.maskMesh.geometry, stencilMaterial);
        mask.userData.sharedGeometry = true;
        mask.position.copy(layer.mesh.position);
        mask.renderOrder = 10000 + layer.index * 2;
        mask.onBeforeRender = () => renderer.clearStencil();
        highlight.add(mask);
      }
      const mesh = new THREE.Mesh(
        geometry,
        layer.maskMesh ? highlightCopperMaterial : highlightMaterial,
      );
      mesh.position.copy(layer.mesh.position);
      mesh.renderOrder = 10001 + layer.index * 2;
      highlight.add(mesh);
    }
  };
  const choose = (objectId, layerId, report = true) => {
    const object = objectMap.get(objectId);
    selectedId = object?.id || null;
    selectedNet = Number.isInteger(object?.net) && object.net > 0 ? object.net : null;
    updateHighlight();
    requestDraw();
    if (report) callbacks.onSelect?.(object ? { ...object, layerId } : null);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    observer?.disconnect();
    controls?.dispose();
    if (renderer) {
      renderer.domElement.removeEventListener('webglcontextlost', contextLost);
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      renderer.domElement.remove();
    }
    clearHighlight();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    renderer?.dispose();
    signal?.removeEventListener('abort', dispose);
    container.dataset.pcb3dReady = 'false';
  };
  const contextLost = event => {
    event.preventDefault();
    lost = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    container.dataset.pcb3dReady = 'false';
    renderer.domElement.dataset.pcb3dReady = 'false';
    callbacks.onError?.('PCB 3D graphics context was lost. Return to 2D or reopen 3D.');
  };
  let down;
  const pointerDown = event => {
    down = { x: event.clientX, y: event.clientY, button: event.button };
  };
  const pointerUp = event => {
    if (
      !down ||
      down.button !== 0 ||
      Math.hypot(down.x - event.clientX, down.y - event.clientY) > 4
    )
      return;
    down = null;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      (-(event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(
      [
        ...[...layers.values()].filter(layer => layer.mesh.visible).map(layer => layer.mesh),
        ...boardMeshes,
      ],
      false,
    );
    // Apply the same drill openings as the GPU mask before accepting a hit.
    const hit = hits.find(candidate => {
      const layer = layers.get(candidate.object.userData.layerId);
      if (!layer) return true;
      return !layer.drillContours.some(contour =>
        inside([candidate.point.x, -candidate.point.y], contour),
      );
    });
    if (!hit || !Number.isInteger(hit.faceIndex)) return choose(null);
    const layer = layers.get(hit.object.userData.layerId);
    if (!layer) return choose(null);
    let lo = 0,
      hi = layer.ranges.length - 1,
      found;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1,
        range = layer.ranges[mid];
      if (hit.faceIndex < range.start) hi = mid - 1;
      else if (hit.faceIndex >= range.start + range.count) lo = mid + 1;
      else {
        found = range;
        break;
      }
    }
    choose(found?.id || null, layer.id);
  };

  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      stencil: true,
      powerPreference: 'low-power',
    });
    if (!renderer.getContext().getContextAttributes()?.stencil)
      throw Error('PCB 3D requires stencil support for real drill openings.');
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(0x101820, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.cssText =
      'display:block;width:100%;height:100%;touch-action:none;outline:none';
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('aria-label', 'PCB 3D canvas');
    container.append(renderer.domElement);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.enablePan = true;
    controls.minDistance = modelSpan / 1000;
    controls.maxDistance = modelSpan * 100;
    controls.addEventListener('change', requestDraw);
    renderer.domElement.addEventListener('webglcontextlost', contextLost);
    renderer.domElement.addEventListener('pointerdown', pointerDown);
    renderer.domElement.addEventListener('pointerup', pointerUp);
    signal?.addEventListener('abort', dispose, { once: true });
    scene.add(new THREE.HemisphereLight(0xffffff, 0x304657, 2));
    const light = new THREE.DirectionalLight(0xffffff, 2.4);
    light.position.set(modelSpan, modelSpan / 2, modelSpan);
    scene.add(light);
    const board = buildPcbSubstrate(
      input,
      thickness,
      input.layers,
      materials,
      geometries,
      counters,
    );
    boardMeshes.push(...board.children);
    content.add(board);
    for (let layerIndex = 0; layerIndex < renderLayers.length; layerIndex++) {
      checkCancelled();
      const source = renderLayers[layerIndex],
        positions = [],
        ranges = [];
      const baseZ = layerZ(source);
      const mask = await buildDrillMask(
        input.holes || [],
        copperOrder,
        source.id,
        baseZ,
        MAX_TRIANGLES - counters.triangles,
        signal,
      );
      checkCancelled();
      if (!mask.complete) {
        counters.omittedPrimitives += source.shapes?.length || 0;
        counters.omittedDrillLayers = (counters.omittedDrillLayers || 0) + 1;
        if (mask.reason === 'unsupported')
          counters.unsupportedDrillLayers = (counters.unsupportedDrillLayers || 0) + 1;
        continue;
      }
      const drillContours = mask.contours;
      let maskMesh;
      if (mask.positions.length) {
        const maskGeometry = new THREE.BufferGeometry();
        maskGeometry.setAttribute('position', new THREE.BufferAttribute(mask.positions, 3));
        geometries.add(maskGeometry);
        counters.triangles += mask.triangles;
        maskMesh = new THREE.Mesh(maskGeometry, stencilMaterial);
        maskMesh.renderOrder = 10 + layerIndex * 4;
        maskMesh.onBeforeRender = () => renderer.clearStencil();
        content.add(maskMesh);
      }
      let sinceYield = 0,
        lastShapeYield = performance.now();
      for (const shape of source.shapes || []) {
        if (++sinceYield >= 250 || performance.now() - lastShapeYield >= 8) {
          sinceYield = 0;
          await yieldFrame();
          checkCancelled();
          lastShapeYield = performance.now();
        }
        if (counters.triangles >= MAX_TRIANGLES || ranges.length >= MAX_PICK_TARGETS) {
          counters.omittedPrimitives++;
          continue;
        }
        const rawEstimate = primitiveTriangleBudget(shape);
        if (rawEstimate === null) {
          counters.unsupportedPrimitives++;
          continue;
        }
        if (counters.triangles + rawEstimate > MAX_TRIANGLES) {
          counters.omittedPrimitives++;
          continue;
        }
        let drilled = shape,
          drillBudgetReached = false;
        const drillBudget = { remaining: 250000 };
        try {
          const objectDrills = drills.get(shape.objectId) || [];
          if (objectDrills.length > 16) throw new TopologyBudgetError();
          for (const hole of objectDrills) {
            if (!drilled) break;
            drilled = subtractDrill(drilled, hole, drillBudget);
          }
        } catch (error) {
          if (!(error instanceof TopologyBudgetError)) throw error;
          drillBudgetReached = true;
        }
        if (!drilled || drillBudgetReached) {
          counters.omittedPrimitives++;
          continue;
        }
        const primitive = buildPcbPrimitive(drilled, baseZ, MAX_TRIANGLES - counters.triangles);
        if (!primitive.complete) {
          if (primitive.reason === 'unsupported') counters.unsupportedPrimitives++;
          else counters.omittedPrimitives++;
          continue;
        }
        const points = primitive.positions,
          triangles = primitive.triangles;
        ranges.push({
          start: positions.length / 9,
          count: triangles,
          id: shape.objectId,
          net: Number.isInteger(shape.net) ? shape.net : null,
        });
        for (const point of points) positions.push(point);
        counters.triangles += triangles;
        counters.renderedPrimitives++;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.computeBoundingSphere();
      geometries.add(geometry);
      const color =
        source.color?.length >= 3
          ? new THREE.Color(...source.color.slice(0, 3))
          : new THREE.Color(0xd3ac70);
      const material = new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -(layerIndex + 1),
      });
      if (maskMesh) {
        material.stencilWrite = true;
        material.stencilRef = 1;
        material.stencilFunc = THREE.NotEqualStencilFunc;
      }
      materials.add(material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.layerId = source.id;
      mesh.renderOrder = 11 + layerIndex * 4;
      content.add(mesh);
      layers.set(source.id, {
        id: source.id,
        mesh,
        maskMesh,
        drillContours,
        ranges,
        baseZ,
        rank: layerRank(source),
        index: layerIndex,
      });
    }
    const box = new THREE.Box3().setFromObject(content);
    if (box.isEmpty()) throw Error('PCB has no supported 3D display geometry.');
    box.getSize(size);
    box.getCenter(center);
    radius = Math.max(size.length() / 2, 0.01);
    target.copy(center);
    const setView = preset => {
      const direction =
        preset === 'top'
          ? new THREE.Vector3(0, -0.001, 1)
          : preset === 'bottom'
            ? new THREE.Vector3(0, -0.001, -1)
            : new THREE.Vector3(0.48, -0.72, 0.7);
      const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
      const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
      fitDistance = (radius / Math.sin(Math.min(vertical, horizontal))) * 1.12;
      camera.position.copy(direction.normalize().multiplyScalar(fitDistance).add(target));
      camera.near = Math.max(0.0001, fitDistance / 500);
      camera.far = fitDistance * 100;
      camera.updateProjectionMatrix();
      controls.target.copy(target);
      controls.update();
      requestDraw();
    };
    const resize = () => {
      if (disposed || lost) return;
      const width = Math.max(1, container.clientWidth),
        height = Math.max(1, container.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      requestDraw();
    };
    observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    setView('isometric');
    checkCancelled();
    const api = {
      setLayers(ids) {
        visibleLayers = new Set(ids);
        for (const layer of layers.values()) {
          layer.mesh.visible = visibleLayers.has(layer.id);
          if (layer.maskMesh) layer.maskMesh.visible = layer.mesh.visible;
        }
        updateHighlight();
        requestDraw();
      },
      setExplode(value) {
        explode = clamp(Number(value) || 0, 0, 1);
        for (const layer of layers.values()) {
          layer.mesh.position.z = layer.rank * modelSpan * 0.035 * explode;
          if (layer.maskMesh) layer.maskMesh.position.copy(layer.mesh.position);
        }
        updateHighlight();
        requestDraw();
      },
      select(id) {
        choose(id, undefined, false);
      },
      zoomBy(factor) {
        if (!finite(factor) || factor <= 0 || disposed || lost) return;
        const offset = camera.position.clone().sub(controls.target);
        const nextDistance = clamp(
          offset.length() / factor,
          controls.minDistance,
          controls.maxDistance,
        );
        camera.position.copy(offset.setLength(nextDistance).add(controls.target));
        controls.update();
        requestDraw();
      },
      fit() {
        setView('isometric');
      },
      setView,
      getState() {
        return {
          sceneId,
          ready: !disposed && !lost,
          percent: percent(),
          selectedId,
          visibleLayers: [...visibleLayers],
          explode,
          camera: camera.position.toArray(),
          target: controls.target.toArray(),
          stats: stats(),
        };
      },
      projectObject(id) {
        for (const layer of layers.values()) {
          if (!layer.mesh.visible) continue;
          const range = layer.ranges.find(item => item.id === id);
          if (!range) continue;
          const array = layer.mesh.geometry.attributes.position.array;
          const index = range.start * 9;
          const point = new THREE.Vector3(
            (array[index] + array[index + 3] + array[index + 6]) / 3,
            (array[index + 1] + array[index + 4] + array[index + 7]) / 3,
            (array[index + 2] + array[index + 5] + array[index + 8]) / 3 + layer.mesh.position.z,
          );
          point.project(camera);
          return {
            x: ((point.x + 1) / 2) * renderer.domElement.clientWidth,
            y: ((1 - point.y) / 2) * renderer.domElement.clientHeight,
            layerId: layer.id,
          };
        }
        return null;
      },
      dispose,
      get stats() {
        return stats();
      },
    };
    builtAt = performance.now();
    draw();
    return api;
  } catch (error) {
    dispose();
    throw error;
  }
}
