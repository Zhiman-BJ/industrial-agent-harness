"""Adapted from the verified KLayout Viewport Lab; real artifacts only."""
import base64
import json
import math
import os
import sys

# Keep native KLayout diagnostics off the line-delimited JSON protocol. GDS
# reader warnings can write directly to fd 1, bypassing Python's sys.stdout.
protocol = os.fdopen(os.dup(sys.stdout.fileno()), 'w', buffering=1)
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())


def respond(message):
    for key in ('result', 'preview'):
        if key in message:
            message[key]['resource'] = resource_status()
    print(json.dumps(message), file=protocol, flush=True)


import klayout.db as db
import klayout.lay as lay
from layout_themes import THEMES
from geometry import extract_geometry
from layout_tiles import render_tile
from layout_resources import MemoryBudgetError, check_resources, resource_status

view = None
identity = None
COLORS = [0x57BBFF, 0x61D6BA, 0xB18EFF, 0xF2C76B, 0xF48AA1, 0x58D5E8, 0xCFDAE8]
for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        check_resources()
        if request['op'] == 'load':
            # No simultaneous old/new database residency during a replacement.
            if view:
                view.destroy()
                view = None
            identity = None
            if os.path.getsize(request['path']) > 128 * 1024 * 1024:
                raise ValueError('Layout import unsupported: input exceeds the 128 MiB local limit.')
            candidate = lay.LayoutView()
            try:
                index = candidate.load_layout(request['path'], 0)
                check_resources()
                cv = candidate.cellview(index)
                tops = list(cv.layout().top_cells())
                if len(tops) != 1:
                    raise ValueError('This viewer requires a layout with exactly one top cell.')
                candidate.max_hier()
                bbox = cv.cell.dbbox()
                if bbox.empty():
                    raise ValueError('Layout contains no geometry.')
                for key in ('grid-visible', 'grid-show-ruler', 'text-visible', 'cell-box-visible'):
                    candidate.set_config(key, 'false')
                candidate.set_config('background-color', '#090f15')
                layers = []
                it = candidate.begin_layers()
                while not it.at_end():
                    props = it.current()
                    key = f'{props.source_layer}/{props.source_datatype}'
                    layers.append({'key': key, 'name': f'Layer {key}', 'layer': props.source_layer})
                    props.fill_color = COLORS[len(layers) % len(COLORS)]
                    props.frame_color = props.fill_color
                    props.dither_pattern = 0
                    candidate.set_layer_properties(it, props)
                    it.next()
            except Exception:
                candidate.destroy()
                raise
            if view:
                view.destroy()
            view = candidate
            identity = request['token']
            result = {'token': identity, 'cell': cv.cell.name, 'bbox': [bbox.left, bbox.bottom, bbox.right, bbox.top], 'layers': layers, 'klayout': db.__version__, 'dbu': cv.layout().dbu}
        elif request['op'] == 'tile':
            if view is None or request['token'] != identity:
                raise ValueError('Layout selection changed; reopen this artifact.')
            result = render_tile(view, request,
                                 lambda preview: respond({'id': request['id'], 'preview': preview}))
        elif request['op'] == 'geometry':
            if view is None or request['token'] != identity:
                raise ValueError('Layout selection changed; reopen this artifact.')
            cv = view.active_cellview()
            result = extract_geometry(cv.layout(), cv.cell, request)
        elif request['op'] == 'render':
            if view is None or request['token'] != identity:
                raise ValueError('Layout selection changed; reopen this artifact.')
            width, height = int(request['width']), int(request['height'])
            box = request['box']
            if not (64 <= width <= 3000 and 64 <= height <= 3000) or len(box) != 4 or not all(math.isfinite(x) for x in box) or box[2] <= box[0] or box[3] <= box[1]:
                raise ValueError('Invalid viewport.')
            visible = set(request['visible'])
            theme = THEMES.get(request.get('theme', '02_blueprint'), THEMES['02_blueprint'])
            view.set_config('background-color', theme['bg'])
            it = view.begin_layers()
            while not it.at_end():
                props = it.current()
                props.visible = f'{props.source_layer}/{props.source_datatype}' in visible
                props.fill_color = int(theme['colors'][(props.source_layer - 1) % len(theme['colors'])], 16)
                props.frame_color = props.fill_color
                props.dither_pattern = 1 if theme['mode'] == 'outline' else 3 if theme['mode'] == 'hatch' else 0
                view.set_layer_properties(it, props)
                it.next()
            region = db.DBox(*box)
            view.zoom_box(region)
            pixels = view.get_pixels_with_options(width, height, 0, 2 if request.get('quality') == 'fine' else 1, 0, region)
            result = {'box': box, 'png': base64.b64encode(pixels.to_png_data()).decode('ascii')}
            pixels.destroy()
        else:
            raise ValueError('Unknown operation.')
        check_resources()
        respond({'id': request['id'], 'result': result})
    except Exception as error:
        respond({'id': request.get('id'), 'error': str(error),
                 'fatal': isinstance(error, MemoryBudgetError)})
        if isinstance(error, MemoryBudgetError):
            break
if view:
    view.destroy()
