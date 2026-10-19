"""Bounded, read-only display geometry for the current KLayout viewport.

XY values retain the layout's micrometre coordinates. Z is a unit extrusion;
the renderer chooses a clearly labelled illustrative layer spacing.
"""
import math
import time

import klayout.db as db
from layout_resources import check_resources

MAX_SHAPES = 5000
MAX_POINTS = 100000
MAX_SHAPE_POINTS = 10000
MAX_TRIANGLES = 80000
MAX_LAYERS = 256
MAX_SECONDS = 8
LIMIT_ERROR = 'Layout geometry limit reached. Zoom in or show fewer layers, then retry.'
COMPLEXITY_ERROR = 'Layout polygon is too complex. Show fewer layers, then retry.'


class GeometryLimitError(ValueError):
    def __init__(self, reason, message=LIMIT_ERROR):
        super().__init__(message)
        self.reason = reason


def grid_box(box, dbu, tile=False):
    """Quantize shared tile boundaries identically; preserve legacy inward clips."""
    raw = [value / dbu for value in box]
    if not all(math.isfinite(value) and abs(value) <= 2 ** 52 for value in raw):
        raise ValueError('Viewport coordinates are outside the supported range.')
    # A decimal DBU boundary such as 32.01 / .001 may divide one ULP below
    # its integer. Correct numerical noise before applying clipping rules.
    aligned = [round(value) if abs(value - round(value)) <= min(4 * math.ulp(value), 1e-7)
               else value for value in raw]
    if tile:
        # Nearest integer; exact half-DBU ties go toward positive infinity.
        # Avoid value + .5, which can itself round large integers upward.
        coords = [math.floor(value) + int(value - math.floor(value) >= .5)
                  for value in aligned]
    else:
        coords = [math.ceil(aligned[0]), math.ceil(aligned[1]),
                  math.floor(aligned[2]), math.floor(aligned[3])]
    if coords[2] <= coords[0] or coords[3] <= coords[1]:
        raise ValueError('Viewport is smaller than one layout database unit.')
    return coords


def extract_geometry(layout, cell, request, budgets=None, tile=False):
    limits = {'maxShapes': MAX_SHAPES, 'maxPoints': MAX_POINTS,
              'maxShapePoints': MAX_SHAPE_POINTS, 'maxTriangles': MAX_TRIANGLES,
              'maxSeconds': MAX_SECONDS}
    if budgets:
        limits.update(budgets)
    started = time.monotonic()
    box = request.get('box')
    visible = request.get('visible')
    if (not isinstance(box, list) or len(box) != 4
            or not all(isinstance(x, (int, float)) and not isinstance(x, bool)
                       and math.isfinite(x) for x in box)
            or box[2] <= box[0] or box[3] <= box[1]):
        raise ValueError('Invalid viewport.')
    if (not isinstance(visible, list) or len(visible) > MAX_LAYERS
            or not all(isinstance(key, str) for key in visible)):
        raise ValueError('Invalid visible layers.')
    dbu = layout.dbu
    if not math.isfinite(dbu) or dbu <= 0:
        raise ValueError('Invalid layout database unit.')
    coords = grid_box(box, dbu, tile)
    clip = db.Box(*coords)
    clip_region = db.Region(clip)
    indices = {f'{layout.get_info(i).layer}/{layout.get_info(i).datatype}': i
               for i in layout.layer_indices()}
    if any(key not in indices for key in visible):
        raise ValueError('Unknown layout layer.')
    output = []
    scanned = points = shape_count = triangle_count = 0

    def check_time():
        check_resources()
        if time.monotonic() - started > limits['maxSeconds']:
            raise GeometryLimitError('time-budget')

    def triangle(target, a, b, c):
        nonlocal triangle_count
        triangle_count += 1
        if triangle_count > limits['maxTriangles']:
            raise GeometryLimitError('triangle-budget')
        if triangle_count % 256 == 0:
            check_time()
        target.extend((*a, *b, *c))

    for key in dict.fromkeys(visible):
        check_time()
        vertices = []
        region = db.Region()
        iterator = cell.begin_shapes_rec_overlapping(indices[key], clip)
        while not iterator.at_end():
            check_time()
            scanned += 1
            if scanned > limits['maxShapes']:
                raise GeometryLimitError('shape-budget')
            shape = iterator.shape()
            if shape.is_box() or shape.is_polygon() or shape.is_simple_polygon() or shape.is_path():
                if shape.is_path():
                    source_points = shape.path.num_points() * 2
                elif shape.is_box():
                    source_points = 4
                else:
                    source_points = shape.polygon.num_points()
                if source_points > limits['maxShapePoints']:
                    raise GeometryLimitError('complex-polygon', COMPLEXITY_ERROR)
                points += source_points
                if points > limits['maxPoints']:
                    raise GeometryLimitError('point-budget')
                polygon = shape.polygon.transformed(iterator.trans())
                region.insert(polygon)
                if not (db.Region(polygon) & clip_region).is_empty():
                    shape_count += 1
            iterator.next()
        # Resolve each layer as one bounded native Region before triangulating.
        # Per-shape meshing can disagree with KLayout's union at diagonal
        # integer-grid intersections, and creates internal overlapping walls.
        source_region = region.merged()
        clipped = (source_region & clip_region).merged()
        check_time()
        for piece in clipped.each():
            check_time()
            if piece.num_points() > limits['maxShapePoints']:
                raise GeometryLimitError('complex-polygon', COMPLEXITY_ERROR)
            for trapezoid in piece.decompose_trapezoids():
                grid_contour = [(p.x, p.y) for p in trapezoid.each_point()]
                if len(grid_contour) < 3:
                    continue
                area = sum(a[0] * b[1] - b[0] * a[1]
                           for a, b in zip(grid_contour, grid_contour[1:] + grid_contour[:1]))
                if area < 0:
                    grid_contour.reverse()
                contour = [(x * dbu, y * dbu) for x, y in grid_contour]
                a = contour[0]
                for index in range(1, len(contour) - 1):
                    b, c = contour[index:index + 2]
                    triangle(vertices, (*a, 1), (*b, 1), (*c, 1))
                    triangle(vertices, (*a, 0), (*c, 0), (*b, 0))
        # Only actual source boundaries become side walls. A tile's artificial
        # cut edges never become surfaces or visible internal seams.
        for edge in (source_region.edges() & clip_region).each():
            a, b = edge.p1, edge.p2
            if a == b:
                continue
            a0, a1 = (a.x * dbu, a.y * dbu, 0), (a.x * dbu, a.y * dbu, 1)
            b0, b1 = (b.x * dbu, b.y * dbu, 0), (b.x * dbu, b.y * dbu, 1)
            triangle(vertices, a0, b1, b0)
            triangle(vertices, a0, a1, b1)
        if vertices:
            output.append({'key': key, 'triangles': vertices})
    check_time()
    return {'token': request['token'], 'box': box, 'layers': output,
            'shapeCount': shape_count, 'triangleCount': triangle_count,
            'limits': {key: limits[key] for key in ('maxShapes', 'maxTriangles', 'maxSeconds')}}
