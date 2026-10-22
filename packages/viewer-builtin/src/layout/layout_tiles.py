"""Small, budgeted exact tiles with an honest sampled fallback from KLayout."""
import base64
import math
import sys
from array import array

import klayout.db as db
from geometry import GeometryLimitError, extract_geometry, grid_box
from layout_resources import check_resources

TILE_BUDGETS = {'maxShapes': 2000, 'maxPoints': 50000,
                'maxShapePoints': 10000, 'maxTriangles': 20000, 'maxSeconds': 2}
TILE_LIMITS = {key: TILE_BUDGETS[key] for key in ('maxShapes', 'maxTriangles', 'maxSeconds')}


def validate_tile(layout, request):
    box = request.get('box')
    if (not isinstance(box, list) or len(box) != 4
            or not all(isinstance(x, (int, float)) and not isinstance(x, bool)
                       and math.isfinite(x) for x in box)
            or box[2] <= box[0] or box[3] <= box[1]):
        raise ValueError('Invalid tile viewport.')
    if not math.isfinite(layout.dbu) or layout.dbu <= 0:
        raise ValueError('Invalid layout database unit.')
    grid_box(box, layout.dbu, tile=True)
    generation = request.get('generation')
    if not isinstance(generation, int) or isinstance(generation, bool) or not 0 <= generation <= 2 ** 53 - 1:
        raise ValueError('Invalid tile generation.')
    if request.get('mode', 'auto') not in ('auto', 'exact', 'overview'):
        raise ValueError('Invalid tile mode.')
    if request.get('pixels', 256) not in (128, 256, 512):
        raise ValueError('Invalid tile raster size.')
    layers = {f'{layout.get_info(i).layer}/{layout.get_info(i).datatype}' for i in layout.layer_indices()}
    if request.get('layer') not in layers:
        raise ValueError('Unknown layout layer.')


def raster_mask(view, request, clip_box):
    """Actual source raster, with no background geometry or invented layer fill."""
    view.set_config('background-color', '#000000')
    iterator = view.begin_layers()
    while not iterator.at_end():
        props = iterator.current()
        props.visible = f'{props.source_layer}/{props.source_datatype}' == request['layer']
        props.fill_color = 0xFFFFFF
        props.frame_color = 0xFFFFFF
        props.dither_pattern = 0
        view.set_layer_properties(iterator, props)
        iterator.next()
    box = clip_box
    span_x, span_y = box[2] - box[0], box[3] - box[1]
    size = request.get('pixels', 256)
    scale = size / max(span_x, span_y)
    width, height = max(1, round(span_x * scale)), max(1, round(span_y * scale))
    region = db.DBox(*box)
    view.zoom_box(region)
    pixels = view.get_pixels_with_options(width, height, 0, 1, 0, region)
    try:
        return base64.b64encode(pixels.to_png_data()).decode('ascii')
    finally:
        pixels.destroy()


def render_tile(view, request, preview=None):
    if check_resources()['monitor'] == 'unavailable':
        raise ValueError('Layout tile rendering unsupported: resource monitoring is unavailable on this platform.')
    cv = view.active_cellview()
    validate_tile(cv.layout(), request)
    clip_box = [value * cv.layout().dbu for value in grid_box(request['box'], cv.layout().dbu, tile=True)]
    common = {'token': request['token'], 'generation': request['generation'],
              'layer': request['layer'], 'box': request['box'], 'clipBox': clip_box,
              'limits': TILE_LIMITS}
    # A completed preview also gives the supervisor an honest fallback if a
    # later native exact-geometry operation times out. Counts describe meshes,
    # not the number of source objects represented by a sampled raster.
    overview = dict(common, mode='overview', png=raster_mask(view, request, clip_box),
                    shapeCount=0, triangleCount=0)
    check_resources()
    if request.get('mode', 'auto') == 'overview':
        return overview
    if preview:
        preview(overview)
    try:
        geometry = extract_geometry(cv.layout(), cv.cell,
                                    dict(request, visible=[request['layer']]), TILE_BUDGETS, tile=True)
    except GeometryLimitError as error:
        return dict(overview, reason=error.reason)
    if not geometry['triangleCount']:
        return dict(common, mode='empty', shapeCount=0, triangleCount=0)
    positions = array('d', geometry['layers'][0]['triangles'])
    if sys.byteorder != 'little':
        positions.byteswap()
    return dict(common, mode='exact',
                encoding='f64le-xyz', positions=base64.b64encode(positions.tobytes()).decode('ascii'),
                shapeCount=geometry['shapeCount'], triangleCount=geometry['triangleCount'])
