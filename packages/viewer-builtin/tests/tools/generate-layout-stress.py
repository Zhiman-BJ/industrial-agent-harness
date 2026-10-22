#!/usr/bin/env python3
"""Generate deterministic synthetic display fixtures; never use production designs.

Run with a KLayout-enabled Python and an explicit scratch --output directory.
The three files exercise repeated hierarchy, genuinely flat unique geometry, and
one unfractured >10k-point polygon. GDS timestamps are disabled for stable SHA-256.
The large polygon uses KLayout's documented multi-XY GDS extension, recorded in
its manifest; ordinary GDS writers may fracture that boundary instead.
"""
import argparse
import hashlib
import json
import math
import random
import time
from pathlib import Path

import klayout.db as db

DBU = 0.001


def sha256(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def translated_array(parent, child, rotation, mirror, x, y, nx=1, ny=1, pitch_x=0, pitch_y=0):
    rotated = child.bbox().transformed(db.Trans(rotation, mirror))
    transform = db.Trans(rotation, mirror, x - rotated.left, y - rotated.bottom)
    if nx == ny == 1:
        parent.insert(db.CellInstArray(child.cell_index(), transform))
    else:
        parent.insert(db.CellInstArray(child.cell_index(), transform,
                                     db.Vector(pitch_x, 0), db.Vector(0, pitch_y), nx, ny))


def hierarchy(seed, layer_count):
    rng = random.Random(seed)
    layout = db.Layout()
    layout.dbu = DBU
    leaf = layout.create_cell('MOTIF')
    for rank in range(layer_count):
        layer = layout.layer(rank + 1, 0)
        for index in range(16):
            x = 2000 + index % 4 * 14000 + rng.randrange(0, 1000)
            y = 2000 + index // 4 * 14000 + rng.randrange(0, 1000)
            leaf.shapes(layer).insert(db.Box(x, y, x + rng.randrange(1000, 8000), y + rng.randrange(1000, 8000)))
        donut = db.Polygon(db.Box(8000, 8000, 18000, 18000))
        donut.insert_hole(db.Box(10000, 10000, 16000, 16000))
        leaf.shapes(layer).insert(donut)
        leaf.shapes(layer).insert(db.Path([db.Point(0, 32000 + rank * 4), db.Point(64000, 32000 + rank * 4)], 8))
        leaf.shapes(layer).insert(db.Path([db.Point(32000 + rank * 4, 0), db.Point(32000 + rank * 4, 64000)], 8))
    tile = layout.create_cell('TILE_8X8')
    translated_array(tile, leaf, 0, False, 0, 0, 8, 8, 80000, 80000)
    supertile = layout.create_cell('ROTATED_MIRRORED_QUAD')
    for index in range(4):
        translated_array(supertile, tile, index, bool(index % 2), index % 2 * 700000, index // 2 * 700000)
    macro = layout.create_cell('MACRO_4X4')
    translated_array(macro, supertile, 0, False, 0, 0, 4, 4, 1400000, 1400000)
    wrapper = layout.create_cell('MIRRORED_WRAPPER')
    translated_array(wrapper, macro, 1, True, 0, 0)
    top = layout.create_cell('TOP_HIERARCHY_32')
    translated_array(top, wrapper, 0, False, 0, 0, 2, 2, 5600000, 5600000)
    bounds = top.bbox()
    for rank in range(layer_count):
        y = bounds.bottom + 10000 + rank * 100
        top.shapes(layout.layer(rank + 1, 0)).insert(db.Path([
            db.Point(bounds.left, y), db.Point(bounds.right // 2, y + 30000),
            db.Point(bounds.right, y)], 20))
    return layout, top, {'detail': [8, 8, 18, 18], 'seam': [31.99, 31.99, 32.03, 32.03]}, {
        'features': ['32 layers', '6 cell levels', '8x8/4x4/2x2 regular arrays',
                     'all orthogonal rotations', 'mirrored hierarchy', 'polygon holes',
                     '8 nm leaf paths', '20 nm cross-macro paths'],
        'expectedLogicalShapes': 19 * layer_count * 64 * 4 * 16 * 4 + layer_count,
    }


def flat(seed, layer_count, shapes_per_layer):
    rng = random.Random(seed ^ 0x5F3759DF)
    layout = db.Layout()
    layout.dbu = DBU
    top = layout.create_cell('TOP_FLAT_UNIQUE_32')
    columns = 128
    for rank in range(layer_count):
        layer = layout.layer(rank + 1, 0)
        for index in range(shapes_per_layer):
            x = index % columns * 2000 + rng.randrange(0, 100)
            y = index // columns * 2000 + rng.randrange(0, 100)
            width, height = rng.randrange(200, 1500), rng.randrange(200, 1500)
            if index % 97 == 0:
                polygon = db.Polygon(db.Box(x, y, x + width, y + height))
                polygon.insert_hole(db.Box(x + width // 4, y + height // 4,
                                          x + width * 3 // 4, y + height * 3 // 4))
                top.shapes(layer).insert(polygon)
            elif index % 113 == 0:
                top.shapes(layer).insert(db.Path([db.Point(x, y), db.Point(x + 6000, y + 1000),
                                                 db.Point(x + 10000, y)], 10 + rank))
            else:
                top.shapes(layer).insert(db.Box(x, y, x + width, y + height))
    return layout, top, {'detail': [10, 10, 14, 14], 'seam': [11.95, 10, 12.05, 14]}, {
        'features': ['32 layers', 'no instances', 'seeded unique coordinates/sizes',
                     'holes', 'thin paths crossing multiple grid cells'],
        'expectedLogicalShapes': layer_count * shapes_per_layer,
    }


def complex_polygon(seed, layer_count, point_count):
    layout = db.Layout()
    layout.dbu = DBU
    top = layout.create_cell('TOP_COMPLEX_POLYGON')
    points = []
    for index in range(point_count):
        angle = index * 2 * math.pi / point_count
        radius = 2000000 if index % 2 == 0 else 1800000
        points.append(db.Point(round(2200000 + radius * math.cos(angle)),
                               round(2200000 + radius * math.sin(angle))))
    top.shapes(layout.layer(1, 0)).insert(db.Polygon(points))
    for rank in range(1, layer_count):
        top.shapes(layout.layer(rank + 1, 0)).insert(db.Box(2100000 + rank, 2100000 + rank,
                                                                        2300000 + rank, 2300000 + rank))
    return layout, top, {'detail': [2199.9, 2199.9, 2200.1, 2200.1],
                         'seam': [2199.99, 2199.9, 2200.01, 2200.1]}, {
        'features': ['32 layers', 'one unfractured 12002-point concave boundary'],
        'expectedLogicalShapes': layer_count, 'minimumPolygonPoints': point_count,
        'gdsMultiXYExtension': True,
    }


def statistics(layout, top):
    indices = list(layout.layer_indices())
    unique = 0
    max_points = 0
    instance_records = 0
    arrays = 0
    for cell in layout.each_cell():
        for index in indices:
            shapes = cell.shapes(index)
            unique += shapes.size()
            for shape in shapes.each():
                if shape.is_polygon() or shape.is_simple_polygon():
                    max_points = max(max_points, shape.polygon.num_points())
        for instance in cell.each_inst():
            instance_records += 1
            arrays += int(instance.na > 1 or instance.nb > 1)
    memo = {}
    def occurrences(cell):
        key = cell.cell_index()
        if key in memo:
            return memo[key]
        count = sum(cell.shapes(index).size() for index in indices)
        depth = 1
        for instance in cell.each_inst():
            nested_count, nested_depth = occurrences(layout.cell(instance.cell_index))
            count += nested_count * max(instance.na, 1) * max(instance.nb, 1)
            depth = max(depth, nested_depth + 1)
        memo[key] = count, depth
        return memo[key]
    count, depth = occurrences(top)
    return {'layerCount': len(indices), 'cellCount': layout.cells(),
            'uniqueShapeRecords': unique, 'logicalShapeOccurrences': count,
            'hierarchyDepth': depth, 'instanceRecords': instance_records,
            'regularArrayRecords': arrays, 'maxPolygonPoints': max_points}


def generate(args):
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    manifest = {'generatorVersion': 1, 'seed': args.seed, 'layers': args.layers,
                'klayoutVersion': db.__version__, 'generatorSha256': sha256(__file__),
                'fixtures': []}
    subjects = [('hierarchy-32', 'hierarchy', lambda: hierarchy(args.seed, args.layers)),
                ('flat-unique-32', 'flat', lambda: flat(args.seed, args.layers, args.flat_per_layer)),
                ('complex-polygon-12002', 'complex', lambda: complex_polygon(args.seed, args.layers, args.points))]
    for name, kind, build in subjects:
        started = time.monotonic()
        layout, top, boxes, metadata = build()
        file = output / f'{name}.gds'
        options = db.SaveLayoutOptions()
        options.gds2_write_timestamps = False
        options.gds2_multi_xy_records = True
        options.gds2_max_vertex_count = max(20000, args.points + 10)
        layout.write(str(file), options)
        reloaded = db.Layout()
        reloaded.read(str(file))
        reloaded_top = reloaded.top_cell()
        stats = statistics(reloaded, reloaded_top)
        assert stats['logicalShapeOccurrences'] == metadata['expectedLogicalShapes'], (name, stats)
        if kind == 'complex':
            assert stats['maxPolygonPoints'] >= args.points, 'GDS writer fractured the difficult polygon'
        bounds = reloaded_top.dbbox()
        boxes['full'] = [bounds.left, bounds.bottom, bounds.right, bounds.top]
        item = {'name': name, 'kind': kind, 'path': str(file), 'bytes': file.stat().st_size,
                'sha256': sha256(file), 'boxes': boxes, 'stats': stats,
                'generationSeconds': round(time.monotonic() - started, 6), **metadata}
        manifest['fixtures'].append(item)
        print(json.dumps({'fixture': name, 'bytes': item['bytes'], **stats}), flush=True)
    manifest_path = output / 'manifest.json'
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'manifest': str(manifest_path)}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--seed', type=int, default=20261019)
    parser.add_argument('--layers', type=int, default=32, choices=[24, 32])
    parser.add_argument('--flat-per-layer', type=int, default=8192)
    parser.add_argument('--points', type=int, default=12002)
    generate(parser.parse_args())
