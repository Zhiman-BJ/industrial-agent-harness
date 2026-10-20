// Read-only geometry from the same pinned KiCanvas painter used by the 2D view.
// No native program, second CAD parser, or invented component body is involved.
const DEFAULT_LIMITS = Object.freeze({
  primitives: 100000,
  points: 1000000,
  outlinePoints: 30000,
  holes: 20000,
});
const finite = value => Number.isFinite(value) && Math.abs(value) < 1e7;
const xy = point => [Number(point.x ?? point[0]), Number(point.y ?? point[1])];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const abort = signal => {
  if (signal?.aborted) throw new DOMException('PCB geometry capture cancelled.', 'AbortError');
};
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

const identity4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiply4(a, b) {
  const result = Array(16).fill(0);
  for (let column = 0; column < 4; column++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++) result[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
  return result;
}
function rotation4(axis, degrees) {
  const angle = (degrees * Math.PI) / 180,
    c = Math.cos(angle),
    s = Math.sin(angle);
  if (axis === 'x') return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  if (axis === 'y') return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
const vector3 = value => Array.isArray(value) && value.length === 3 && value.every(finite);

/**
 * KiCad's native assembly transform, as a column-major matrix, in millimetres.
 * Assets must already use KiCad's right-handed model coordinates in mm. Only
 * the footprint's board Y is inverted; model-local Y must not be reflected.
 * Matches KiCad 10.0.6 RENDER_3D_OPENGL::get3dModelsFromFootprint.
 */
export function componentMatrix(component, model, zSurface) {
  if (
    component?.error ||
    model?.error ||
    !Array.isArray(component?.at) ||
    component.at.length !== 2 ||
    !component.at.every(finite) ||
    !finite(component.rotation) ||
    !['front', 'back'].includes(component.side) ||
    !finite(zSurface) ||
    !vector3(model?.offset) ||
    !vector3(model?.rotation) ||
    !vector3(model?.scale)
  )
    throw Error('Invalid PCB component model placement; assembly transform omitted.');
  let matrix = identity4();
  matrix[12] = component.at[0];
  matrix[13] = -component.at[1];
  matrix[14] = zSurface;
  matrix = multiply4(matrix, rotation4('z', component.rotation));
  if (component.side === 'back') {
    matrix = multiply4(matrix, rotation4('y', 180));
    matrix = multiply4(matrix, rotation4('z', 180));
  }
  const translation = identity4();
  translation.splice(12, 3, ...model.offset);
  matrix = multiply4(matrix, translation);
  for (const [axis, index] of [
    ['z', 2],
    ['y', 1],
    ['x', 0],
  ])
    matrix = multiply4(matrix, rotation4(axis, -model.rotation[index]));
  const scale = identity4();
  scale[0] = model.scale[0];
  scale[5] = model.scale[1];
  scale[10] = model.scale[2];
  return multiply4(matrix, scale);
}

/** Map KiCanvas virtual paint layers to the physical layer they represent. */
export function physicalLayer(name) {
  if (name === ':Pads:Front') return 'F.Cu';
  if (name === ':Pads:Back') return 'B.Cu';
  if (/^:.*\.Cu:Zones$/.test(name)) return name.slice(1, -6);
  if (/^(?:F|B)\.(?:SilkS|Cu)$/.test(name) || /^In\d+\.Cu$/.test(name)) return name;
  return null;
}

function area(points) {
  let value = 0;
  for (let i = 0; i + 1 < points.length; i++)
    value += points[i][0] * points[i + 1][1] - points[i + 1][0] * points[i][1];
  return value / 2;
}
function contains(points, point) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i],
      b = points[j];
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function intersects(a, b, c, d, tolerance) {
  const abC = cross(a, b, c),
    abD = cross(a, b, d);
  const cdA = cross(c, d, a),
    cdB = cross(c, d, b);
  const epsilon = tolerance * 1e-3;
  return abC * abD <= epsilon && cdA * cdB <= epsilon;
}

/**
 * Join actual Edge.Cuts centre-lines. Open, branching, touching or self-crossing
 * contours never become a fabricated rectangular board. Nested loops are holes.
 */
export function stitchOutline(paths, tolerance = 0.001, maxPoints = DEFAULT_LIMITS.outlinePoints) {
  const warnings = [];
  const rings = [],
    edges = [],
    nodes = [],
    buckets = new Map();
  let count = 0;
  const nodeAt = point => {
    const ix = Math.floor(point[0] / tolerance),
      iy = Math.floor(point[1] / tolerance);
    for (let x = ix - 1; x <= ix + 1; x++)
      for (let y = iy - 1; y <= iy + 1; y++) {
        for (const index of buckets.get(`${x}:${y}`) || [])
          if (distance(nodes[index].point, point) <= tolerance) return index;
      }
    const index = nodes.length,
      key = `${ix}:${iy}`;
    nodes.push({ point, edges: [] });
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(index);
    return index;
  };
  const fail = message => ({ outline: [], warnings: [message] });
  for (const source of paths) {
    const points = source.filter((point, i) => !i || distance(point, source[i - 1]) > 1e-10);
    count += points.length;
    if (count > maxPoints)
      return fail('PCB outline exceeds the display geometry budget; board solid omitted.');
    if (points.length < 2 || !points.every(point => point.length === 2 && point.every(finite)))
      continue;
    if (distance(points[0], points.at(-1)) <= tolerance) {
      points[points.length - 1] = points[0];
      rings.push(points);
    } else {
      const start = nodeAt(points[0]),
        end = nodeAt(points.at(-1)),
        index = edges.length;
      edges.push({ points, start, end });
      nodes[start].edges.push(index);
      nodes[end].edges.push(index);
    }
  }
  if (nodes.some(node => node.edges.length !== 2))
    return fail('PCB Edge.Cuts is open or branching; board solid omitted.');
  const visited = new Set();
  for (let startEdge = 0; startEdge < edges.length; startEdge++) {
    if (visited.has(startEdge)) continue;
    let edgeIndex = startEdge,
      node = edges[startEdge].start;
    const startNode = node,
      ring = [];
    while (!visited.has(edgeIndex)) {
      const edge = edges[edgeIndex];
      visited.add(edgeIndex);
      const points = edge.start === node ? edge.points : [...edge.points].reverse();
      ring.push(...(ring.length ? points.slice(1) : points));
      node = edge.start === node ? edge.end : edge.start;
      if (node === startNode) break;
      edgeIndex = nodes[node].edges.find(index => !visited.has(index));
      if (edgeIndex === undefined)
        return fail('PCB Edge.Cuts does not form closed contours; board solid omitted.');
    }
    if (node !== startNode)
      return fail('PCB Edge.Cuts does not form closed contours; board solid omitted.');
    ring[ring.length - 1] = ring[0];
    rings.push(ring);
  }
  if (!rings.length) return fail('No closed PCB Edge.Cuts contour was found; board solid omitted.');
  if (rings.some(ring => ring.length < 4 || Math.abs(area(ring)) < tolerance * tolerance))
    return fail('PCB Edge.Cuts contains a degenerate contour; board solid omitted.');
  // Sweep segment bounds rather than comparing every pair of curve samples.
  const segments = [];
  for (let ring = 0; ring < rings.length; ring++)
    for (let i = 0; i + 1 < rings[ring].length; i++) {
      const a = rings[ring][i],
        b = rings[ring][i + 1];
      segments.push({
        ring,
        i,
        a,
        b,
        minX: Math.min(a[0], b[0]),
        maxX: Math.max(a[0], b[0]),
        minY: Math.min(a[1], b[1]),
        maxY: Math.max(a[1], b[1]),
      });
    }
  segments.sort((a, b) => a.minX - b.minX);
  let active = [],
    checks = 0;
  for (const segment of segments) {
    active = active.filter(other => other.maxX >= segment.minX - 1e-9);
    for (const other of active) {
      if (++checks > 1000000)
        return fail('PCB outline topology exceeds the display budget; board solid omitted.');
      if (other.maxY < segment.minY - 1e-9 || other.minY > segment.maxY + 1e-9) continue;
      const adjacent =
        segment.ring === other.ring &&
        (Math.abs(segment.i - other.i) === 1 ||
          Math.abs(segment.i - other.i) === rings[segment.ring].length - 2);
      if (!adjacent && intersects(segment.a, segment.b, other.a, other.b, tolerance))
        return fail('PCB Edge.Cuts intersects or touches itself; board solid omitted.');
    }
    active.push(segment);
  }
  if (rings.length > 2000) return fail('PCB outline has too many contours; board solid omitted.');
  let containmentChecks = 0;
  const outline = [];
  for (const points of rings) {
    let containing = 0;
    for (const other of rings) {
      if (other === points) continue;
      containmentChecks += other.length;
      if (containmentChecks > 2000000)
        return fail('PCB outline containment exceeds the display budget; board solid omitted.');
      if (contains(other, points[0])) containing++;
    }
    outline.push({ points, hole: containing % 2 === 1 });
  }
  return { outline, warnings };
}

function inspectSourceFeatures(sourceText = '') {
  let declaredThickness = false;
  let unsupportedSublayers = false;
  let footprintIndex = -1;
  const legacyModelOffsets = new Set();
  const sourceHeads = [];
  // Only detect declaration presence and syntax the pinned upstream parser does
  // not retain. Values and CAD semantics remain owned by that parser. In
  // particular it drops bare dielectric addsublayer and overwrites repeated
  // thickness fields: those files cannot be labelled a physical stackup here.
  for (const match of sourceText.matchAll(/"(?:\\.|[^"\\])*"|[()]|[^\s()"]+/g)) {
    const token = match[0];
    if (token === '(') sourceHeads.push({ head: null, thicknessDeclarations: 0 });
    else if (token === ')') sourceHeads.pop();
    else {
      const current = sourceHeads.at(-1);
      if (!current) continue;
      const isHead = current.head === null;
      if (isHead) current.head = token;
      if (isHead && sourceHeads[0].head === 'kicad_pcb') {
        if (sourceHeads.length === 2 && token === 'footprint') {
          current.footprintIndex = ++footprintIndex;
          current.modelCount = 0;
        }
        if (sourceHeads.length === 3 && sourceHeads[1].head === 'footprint' && token === 'model')
          current.modelIndex = sourceHeads[1].modelCount++;
        if (
          sourceHeads.length === 4 &&
          sourceHeads[1].head === 'footprint' &&
          sourceHeads[2].head === 'model' &&
          token === 'at'
        )
          legacyModelOffsets.add(`${sourceHeads[1].footprintIndex}:${sourceHeads[2].modelIndex}`);
      }
      if (
        isHead &&
        sourceHeads.length === 3 &&
        sourceHeads[0].head === 'kicad_pcb' &&
        sourceHeads[1].head === 'general' &&
        token === 'thickness'
      )
        declaredThickness = true;
      const inStackLayer =
        sourceHeads[0]?.head === 'kicad_pcb' &&
        sourceHeads[1]?.head === 'setup' &&
        sourceHeads[2]?.head === 'stackup' &&
        sourceHeads[3]?.head === 'layer';
      if (inStackLayer) {
        if (
          token === 'addsublayer' &&
          (sourceHeads.length === 4 || (isHead && sourceHeads.length === 5))
        )
          unsupportedSublayers = true;
        if (
          isHead &&
          token === 'thickness' &&
          sourceHeads.length === 5 &&
          ++sourceHeads[3].thicknessDeclarations > 1
        )
          unsupportedSublayers = true;
      }
    }
  }
  return { declaredThickness, unsupportedSublayers, legacyModelOffsets };
}

/** Read physical copper positions only when every dielectric/copper thickness exists. */
export function stackupPositions(
  board,
  sourceText = '',
  features = inspectSourceFeatures(sourceText),
) {
  const layers = board.layers || [];
  const { declaredThickness, unsupportedSublayers } = features;
  let thickness = declaredThickness ? board.general?.thickness : null;
  if (!(finite(thickness) && thickness > 0)) thickness = null;
  const stack = (board.setup?.stackup?.layers || []).filter(
    layer => layer.name?.endsWith('.Cu') || /dielectric/i.test(`${layer.name} ${layer.type}`),
  );
  const actualCopper = layers
    .map(layer => layer.canonical_name || layer.name)
    .filter(name => name?.endsWith('.Cu'));
  const orderedCopper = [...actualCopper].sort((a, b) => {
    const position = name =>
      name === 'F.Cu' ? 0 : name === 'B.Cu' ? 31 : Number(/^In(\d+)\.Cu$/.exec(name)?.[1]);
    return position(a) - position(b);
  });
  const stackCopper = stack.filter(layer => layer.name?.endsWith('.Cu')).map(layer => layer.name);
  const correctCopperSequence =
    actualCopper.length >= 2 &&
    actualCopper.length === new Set(actualCopper).size &&
    orderedCopper[0] === 'F.Cu' &&
    orderedCopper.at(-1) === 'B.Cu' &&
    actualCopper.every(name => /^(?:F|B|In(?:[1-9]|[12]\d|30))\.Cu$/.test(name)) &&
    orderedCopper.length === stackCopper.length &&
    orderedCopper.every((name, index) => name === stackCopper[index]) &&
    stack[0]?.name === 'F.Cu' &&
    stack.at(-1)?.name === 'B.Cu';
  const valid =
    !unsupportedSublayers &&
    stack.length &&
    correctCopperSequence &&
    stack.every(layer => finite(layer.thickness) && layer.thickness > 0) &&
    stack.every(layer => !layer.name.endsWith('.Cu') || actualCopper.includes(layer.name));
  const result = new Map();
  if (!valid)
    return {
      positions: result,
      thickness,
      zMode: 'schematic',
      warnings: [
        unsupportedSublayers
          ? 'PCB dielectric sublayers or repeated layer thickness are unsupported; layer spacing is schematic.'
          : !correctCopperSequence && stack.length
            ? 'PCB copper stackup is missing, duplicated or out of order; layer spacing is schematic.'
            : 'PCB layer thickness is incomplete; layer spacing is schematic, not a physical stackup.',
      ],
    };
  const total = stack.reduce((sum, layer) => sum + layer.thickness, 0);
  let cursor = total / 2;
  for (const layer of stack) {
    if (layer.name.endsWith('.Cu'))
      result.set(layer.name, { z: cursor - layer.thickness / 2, thickness: layer.thickness });
    cursor -= layer.thickness;
  }
  const warnings = [];
  if (thickness !== null && Math.abs(total - thickness) > Math.max(0.01, thickness * 0.02))
    warnings.push('PCB stackup thickness differs from the declared board thickness.');
  return {
    positions: result,
    thickness: total,
    declaredThickness: thickness,
    zMode: 'stackup',
    warnings,
  };
}

function toColor(color) {
  const values = color?.to_array?.() || [color?.r, color?.g, color?.b];
  return values.slice(0, 3).every(Number.isFinite) ? values.slice(0, 3) : [0.7, 0.75, 0.8];
}
function netNumber(item) {
  const net = typeof item?.net === 'number' ? item.net : item?.net?.number;
  return Number.isInteger(net) ? net : null;
}
function contourOf(shape) {
  if (shape.kind === 'line') return shape.points;
  if (shape.kind === 'polygon') return [...shape.points, shape.points[0]];
  if (shape.kind === 'circle') {
    // Explicit chord error <= 0.01 mm; circle is itself a source primitive.
    const segments = Math.max(
      24,
      Math.min(4096, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - 0.01 / shape.radius)))),
    );
    return Array.from({ length: segments + 1 }, (_, i) => [
      shape.center[0] + Math.cos((i * 2 * Math.PI) / segments) * shape.radius,
      shape.center[1] + Math.sin((i * 2 * Math.PI) / segments) * shape.radius,
    ]);
  }
  return [];
}

/**
 * Capture transformed source primitives using an independent upstream painter.
 * The existing 2D renderer, camera, layers, and source document are retained.
 */
export async function capturePcbGeometry(viewer, options = {}) {
  abort(options.signal);
  const { BoardPainter, BoardLayerSet, NullRenderer } =
    options.engine || (await import('./kicanvas.js'));
  const board = viewer.board;
  if (!board?.items || !viewer.theme) throw Error('The KiCad board is not ready for 3D viewing.');
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const key of Object.keys(DEFAULT_LIMITS))
    if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > DEFAULT_LIMITS[key])
      throw Error('Invalid PCB display geometry budget.');
  const features = inspectSourceFeatures(options.sourceText);
  const stack = stackupPositions(board, options.sourceText, features);
  const warnings = new Set(stack.warnings),
    objects = new Map(),
    itemIds = new WeakMap(),
    sourceOwners = new Map(),
    contexts = [];
  const outputLayers = new Map(),
    holes = new Map(),
    outlinePaths = [];
  const stats = {
    primitives: 0,
    totalPrimitives: 0,
    omittedPrimitives: 0,
    points: 0,
    unsupportedItems: 0,
  };
  const unsupportedSourceItems = new WeakSet();
  const unsupported = (item, warning) => {
    warnings.add(warning);
    if (!unsupportedSourceItems.has(item)) {
      unsupportedSourceItems.add(item);
      stats.unsupportedItems++;
    }
  };
  const copperLayers = (board.layers || [])
    .map(layer => layer.canonical_name || layer.name)
    .filter(name => name?.endsWith('.Cu'));
  const netNames = new Map((board.nets || []).map(net => [net.number, net.name]));
  let anonymous = 0,
    outlinePointCount = 0,
    invalidGeometry = 0;
  const idFor = item => {
    if (!itemIds.has(item)) {
      const sourceId = item.unique_id || item.uuid || item.tstamp;
      let id = sourceId || `view-${++anonymous}`;
      if (sourceId && sourceOwners.has(sourceId) && sourceOwners.get(sourceId) !== item) {
        id = `${sourceId}:occurrence-${++anonymous}`;
        warnings.add(
          'PCB source has repeated object identifiers; duplicate occurrences use distinct display IDs.',
        );
      }
      if (sourceId) sourceOwners.set(sourceId, item);
      itemIds.set(item, id);
    }
    return itemIds.get(item);
  };
  const metadata = () => {
    // A custom pad's GrPoly/GrLine remains part of its parent Pad, with the same
    // source ID and net; the leaf drawing is not a separate electrical object.
    const item = contexts.findLast(entry => entry.constructor?.name === 'Pad') || contexts.at(-1),
      footprint = contexts.find(entry => entry.constructor?.name === 'Footprint');
    if (!item) return null;
    const id = idFor(item),
      kind = item.constructor?.name || 'Item';
    const sourceId = item.unique_id || item.uuid || item.tstamp || null;
    const net = netNumber(item),
      netName = item.netname || item.net?.name || (net !== null ? netNames.get(net) : null) || null;
    const reference = footprint?.reference || (kind === 'Footprint' ? item.reference : null);
    const footprintId = footprint ? idFor(footprint) : null;
    if (!objects.has(id))
      objects.set(id, {
        id,
        sourceId,
        kind,
        reference,
        footprintId,
        net,
        netName,
        label: reference
          ? `${reference}${kind === 'Pad' ? ` · ${item.number}` : ''}`
          : netName
            ? `${kind} · ${netName}`
            : kind,
      });
    if (footprint && !objects.has(footprintId))
      objects.set(footprintId, {
        id: footprintId,
        sourceId: footprint.unique_id || footprint.uuid || footprint.tstamp || null,
        kind: 'Footprint',
        label: reference || 'Footprint',
        reference,
        footprintId: null,
        net: null,
        netName: null,
      });
    return { item, objectId: id, sourceId, footprintId, net };
  };
  const viewLayers = new BoardLayerSet(board, viewer.theme);
  const getLayer = (id, color) => {
    if (!outputLayers.has(id)) {
      const physical = viewLayers.by_name(id),
        position = stack.positions.get(id);
      let z = position?.z ?? null;
      if (stack.zMode === 'stackup' && id === 'F.SilkS') z = stack.thickness / 2 + 0.01;
      if (stack.zMode === 'stackup' && id === 'B.SilkS') z = -stack.thickness / 2 - 0.01;
      outputLayers.set(id, {
        id,
        name: id,
        color: toColor(physical?.color || color),
        z,
        thickness: position?.thickness ?? null,
        shapes: [],
        stats: { primitives: 0, totalPrimitives: 0, omittedPrimitives: 0, points: 0 },
      });
    }
    return outputLayers.get(id);
  };
  const capture = (kind, raw, name) => {
    const context = metadata();
    if (!context) return;
    const shape = {
      kind,
      objectId: context.objectId,
      sourceId: context.sourceId,
      footprintId: context.footprintId,
      net: context.net,
    };
    if (kind === 'circle') {
      shape.center = xy(raw.center);
      shape.radius = raw.radius;
    } else {
      shape.points = raw.points.map(xy);
      if (kind === 'line') shape.width = raw.width;
    }
    const points = shape.points || [shape.center];
    if (
      !points.length ||
      !points.every(point => point.every(finite)) ||
      (kind === 'circle' && !(finite(shape.radius) && shape.radius > 0)) ||
      (kind === 'line' && !(finite(shape.width) && shape.width >= 0))
    ) {
      if (
        name === 'Edge.Cuts' ||
        name === ':Pad:Holes' ||
        name === ':NonPlatedHoles' ||
        /^:.*(?:Via:Holes|BBViaHoles)$/.test(name)
      )
        throw Error('PCB outline or drilling has invalid geometry. The 2D view remains available.');
      invalidGeometry++;
      return;
    }
    if (name === 'Edge.Cuts') {
      const path = contourOf(shape);
      outlinePointCount += path.length;
      if (outlinePointCount > limits.outlinePoints)
        throw Error('PCB outline exceeds the 3D display budget. The 2D view remains available.');
      outlinePaths.push(path);
      return;
    }
    if (
      name === ':Pad:Holes' ||
      name === ':NonPlatedHoles' ||
      /^:.*(?:Via:Holes|BBViaHoles)$/.test(name)
    ) {
      let center,
        size,
        rotation = 0;
      if (kind === 'circle') {
        center = shape.center;
        size = [shape.radius * 2, shape.radius * 2];
      } else if (kind === 'line' && shape.points.length === 2 && shape.width > 0) {
        const [a, b] = shape.points;
        center = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        size = [distance(a, b) + shape.width, shape.width];
        rotation = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      } else {
        // Blind-via start/end layer markers are decorative arcs drawn on the
        // hole paint layer. The preceding circle already records the real drill.
        if (context.item.constructor?.name === 'Via') return;
        throw Error(
          'PCB drilling is unsupported by the 3D display. The 2D view remains available.',
        );
      }
      const item = context.item,
        span = item.constructor?.name === 'Via' ? item.layers : null;
      const key = `${context.objectId}:${center}:${size}`;
      holes.set(key, {
        center,
        size,
        rotation,
        plated: item.type !== 'np_thru_hole',
        startLayer: span?.[0] || 'F.Cu',
        endLayer: span?.[1] || 'B.Cu',
        objectId: context.objectId,
      });
      if (holes.size > limits.holes)
        throw Error('PCB drilling exceeds the 3D display budget. The 2D view remains available.');
      return;
    }
    let ids = [physicalLayer(name)].filter(Boolean);
    if (
      context.item.constructor?.name === 'Via' &&
      /(?:Via:HoleWalls|BBViaHoleWalls)$/.test(name)
    ) {
      // Source via diameter defines its annulus on the actual source span.
      const match = /^:(.*\.Cu):BBViaHoleWalls$/.exec(name);
      ids = match ? [match[1]] : copperLayers;
    }
    if (
      context.item.constructor?.name === 'Pad' &&
      name === ':Pads:Front' &&
      context.item.type === 'thru_hole' &&
      context.item.layers?.includes('*.Cu')
    ) {
      if (context.item.remove_unused_layers) {
        unsupported(
          context.item,
          'Unused internal through-hole pad layers are not reconstructed by this preview.',
        );
      } else ids = copperLayers.filter(id => id !== 'B.Cu');
    }
    for (const id of ids) {
      const layer = getLayer(id, raw.color);
      stats.totalPrimitives++;
      layer.stats.totalPrimitives++;
      if (stats.primitives >= limits.primitives || stats.points + points.length > limits.points) {
        stats.omittedPrimitives++;
        layer.stats.omittedPrimitives++;
        continue;
      }
      stats.primitives++;
      stats.points += points.length;
      layer.stats.primitives++;
      layer.stats.points += points.length;
      layer.shapes.push(shape);
    }
  };
  class RecordingRenderer extends NullRenderer {
    start_layer(name) {
      super.start_layer(name);
      this.active = super.end_layer();
      this.layerName = name;
    }
    circle(...args) {
      super.circle(...args);
      capture('circle', this.active.shapes.pop(), this.layerName);
    }
    line(...args) {
      super.line(...args);
      capture('line', this.active.shapes.pop(), this.layerName);
    }
    polygon(...args) {
      super.polygon(...args);
      capture('polygon', this.active.shapes.pop(), this.layerName);
    }
    // prep_arc invokes this.line with the upstream tessellated curve. Discard the
    // additional Arc record that NullRenderer retains, so no arc is drawn twice.
    arc(...args) {
      super.arc(...args);
      this.active.shapes.length = 0;
    }
  }
  const renderer = new RecordingRenderer(),
    painter = new BoardPainter(renderer, viewLayers, viewer.theme);
  const originalLayers = painter.layers_for;
  painter.layers_for = function (item) {
    // Upstream expands F&B.Cu by mutating Zone.layers. Copy that field for the
    // call, retaining the original parsed source document for 2D browsing.
    if (item.layers?.includes('F&B.Cu')) {
      const layers = item.layers;
      item.layers = [...layers];
      try {
        return originalLayers.call(this, item);
      } finally {
        item.layers = layers;
      }
    }
    return originalLayers.call(this, item);
  };
  const originalPaint = painter.paint_item;
  painter.paint_item = function (layer, item, ...rest) {
    if (item.constructor?.name === 'Pad') {
      const shape =
        item.shape === 'custom' && item.options?.anchor ? item.options.anchor : item.shape;
      if (!['circle', 'rect', 'roundrect', 'trapezoid', 'oval', 'custom'].includes(shape))
        unsupported(item, 'Some source pad shapes are unsupported by the pinned KiCanvas painter.');
      if (item.chamfer && Object.values(item.chamfer).some(Boolean))
        unsupported(
          item,
          'Chamfered pad corners are not reconstructed by the pinned KiCanvas painter.',
        );
      // This must be checked before drawing: an unsupported/empty pad may emit
      // no primitive, so a warning inside capture() alone would miss it.
      if (item.type === 'thru_hole' && item.remove_unused_layers && item.layers?.includes('*.Cu'))
        unsupported(
          item,
          'Unused internal through-hole pad layers are not reconstructed by this preview.',
        );
    }
    contexts.push(item);
    try {
      return originalPaint.call(this, layer, item, ...rest);
    } finally {
      contexts.pop();
    }
  };
  let lastYield = performance.now();
  try {
    // Populate only relevant display layers, without changing the viewer's own
    // layer visibility, rendering caches, selection, or painter instance.
    for (const item of board.items()) {
      abort(options.signal);
      for (const name of painter.layers_for(item)) {
        if (
          !physicalLayer(name) &&
          name !== 'Edge.Cuts' &&
          name !== ':Pad:Holes' &&
          name !== ':NonPlatedHoles' &&
          !/^:.*(?:Via:Holes|BBViaHoles|Via:HoleWalls|BBViaHoleWalls)$/.test(name)
        )
          continue;
        const layer = viewLayers.by_name(name);
        if (!layer) continue;
        renderer.start_layer(name);
        painter.paint_item(layer, item);
        renderer.end_layer();
      }
      if (performance.now() - lastYield > 12) {
        await pause();
        abort(options.signal);
        lastYield = performance.now();
      }
    }
    abort(options.signal);
    const topology =
      outlinePointCount > limits.outlinePoints
        ? {
            outline: [],
            warnings: ['PCB outline exceeds the display geometry budget; board solid omitted.'],
          }
        : stitchOutline(outlinePaths, 0.001, limits.outlinePoints);
    for (const warning of topology.warnings) warnings.add(warning);
    if (stats.omittedPrimitives)
      warnings.add('PCB 3D display geometry budget reached; some primitives are omitted.');
    if (invalidGeometry)
      warnings.add('Some non-finite or invalid PCB display primitives were omitted.');
    if ((board.footprints || []).length)
      warnings.add(
        'Component bodies are not loaded; the preview shows source board geometry and footprints.',
      );
    // Include empty copper layers in the layer list: source presence is useful
    // even when no trace/zone happens to be drawn on that plane.
    for (const source of board.layers || []) {
      const name = source.canonical_name || source.name;
      if (name?.endsWith('.Cu')) getLayer(name);
    }
    const sourceOrder = new Map(
      (board.layers || []).map((layer, i) => [layer.canonical_name || layer.name, i]),
    );
    const layers = [...outputLayers.values()].sort(
      (a, b) => (sourceOrder.get(a.id) ?? 1000) - (sourceOrder.get(b.id) ?? 1000),
    );
    // Preserve model references and local transforms exactly as parsed. Loading
    // bounded project assets belongs to the host, never to the source painter.
    const components = (board.footprints || []).map((footprint, footprintIndex) => {
      const footprintId = idFor(footprint);
      const component = {
        id: footprintId,
        footprintId,
        reference: footprint.reference || null,
        at: [footprint.at?.position?.x ?? null, footprint.at?.position?.y ?? null],
        rotation: footprint.at?.rotation ?? null,
        side: footprint.layer === 'F.Cu' ? 'front' : footprint.layer === 'B.Cu' ? 'back' : null,
        models: [],
      };
      if (!component.at.every(finite) || !finite(component.rotation) || !component.side) {
        component.error = 'The source footprint position, rotation or side is invalid.';
        warnings.add('Some component model placements are invalid; those bodies are unavailable.');
      }
      if (!objects.has(footprintId))
        objects.set(footprintId, {
          id: footprintId,
          sourceId: footprint.unique_id || footprint.uuid || footprint.tstamp || null,
          kind: 'Footprint',
          label: component.reference || 'Footprint',
          reference: component.reference,
          footprintId: null,
          net: null,
          netName: null,
        });
      component.models = (footprint.models || []).map((source, index) => {
        const model = {
          index,
          path: source.filename,
          offset: source.offset === undefined ? [0, 0, 0] : source.offset?.xyz,
          rotation: source.rotate === undefined ? [0, 0, 0] : source.rotate?.xyz,
          scale: source.scale === undefined ? [1, 1, 1] : source.scale?.xyz,
          hidden: source.hide === true,
          opacity: source.opacity === undefined ? 1 : source.opacity,
        };
        if (features.legacyModelOffsets.has(`${footprintIndex}:${index}`))
          model.error = 'Legacy model at offsets are unsupported by the pinned KiCanvas parser.';
        else if (
          typeof model.path !== 'string' ||
          !model.path.length ||
          !vector3(model.offset) ||
          !vector3(model.rotation) ||
          !vector3(model.scale) ||
          !Number.isFinite(model.opacity) ||
          model.opacity < 0 ||
          model.opacity > 1
        )
          model.error = 'The source model path, transform or opacity is invalid.';
        if (model.error && !model.hidden)
          warnings.add(
            'Some component model references are unsupported or invalid; those bodies are unavailable.',
          );
        // Do not share mutable arrays with the parsed document.
        for (const field of ['offset', 'rotation', 'scale'])
          if (Array.isArray(model[field])) model[field] = [...model[field]];
        return model;
      });
      return component;
    });
    return {
      version: 1,
      units: 'mm',
      sourceSha256: options.sourceSha256 || null,
      complete:
        !stats.omittedPrimitives &&
        !invalidGeometry &&
        !stats.unsupportedItems &&
        topology.outline.length > 0,
      board: {
        thickness: stack.thickness,
        declaredThickness: stack.declaredThickness ?? null,
        outline: topology.outline,
        zMode: stack.zMode,
      },
      layers,
      holes: [...holes.values()],
      objects: [...objects.values()],
      components,
      warnings: [...warnings],
      stats,
    };
  } finally {
    renderer.dispose();
    viewLayers.dispose();
  }
}
