#!/usr/bin/env python3
"""Independent exact source-Region oracle for recorded tile responses."""
import argparse
import base64
import json
import math
import struct
from pathlib import Path

import klayout.db as db


def coordinates(tile):
    if tile['mode'] == 'empty':
        return []
    assert tile['mode'] == 'exact' and tile['encoding'] == 'f64le-xyz', tile['mode']
    raw = base64.b64decode(tile['positions'])
    assert len(raw) == tile['triangleCount'] * 9 * 8
    return [item[0] for item in struct.iter_unpack('<d', raw)]


def cap_region(values, dbu):
    region = db.Region()
    for offset in range(0, len(values), 9):
        tri = values[offset:offset + 9]
        if tri[2] == tri[5] == tri[8] == 1:
            region.insert(db.Polygon([db.Point(round(tri[j] / dbu), round(tri[j + 1] / dbu))
                                      for j in (0, 3, 6)]))
    return region.merged()


def clip_box(box, dbu):
    # Tiles share one nearest-DBU boundary (ties toward +infinity).
    # This oracle deliberately does not import production grid helpers.
    def nearest(value):
        scaled = value / dbu
        lower = math.floor(scaled)
        return lower + int(scaled - lower >= 0.5)
    return db.Box(*(nearest(value) for value in box))


def verify(job):
    layout = db.Layout()
    layout.read(job['source'])
    cell, dbu = layout.top_cell(), layout.dbu
    indices = {f'{layout.get_info(i).layer}/{layout.get_info(i).datatype}': i
               for i in layout.layer_indices()}
    results = []
    for record in job['tiles']:
        tile = record['response']
        if tile['mode'] not in ['exact', 'empty']:
            continue
        clip = clip_box(tile['box'], dbu)
        actual_clip = tile.get('clipBox')
        assert isinstance(actual_clip, list) and len(actual_clip) == 4, 'Exact tile must report clipBox'
        assert clip_box(actual_clip, dbu) == clip, (tile['box'], actual_clip, str(clip))
        assert all(abs(a - b) <= dbu * 0.5000001 for a, b in zip(actual_clip, tile['box'])), 'Tile snap exceeds half a DBU'
        expected = (db.Region(cell.begin_shapes_rec_overlapping(indices[tile['layer']], clip)) & db.Region(clip)).merged()
        values = coordinates(tile)
        projected = cap_region(values, dbu)
        missing, extra = expected - projected, projected - expected
        results.append({'case': record['case'], 'layer': tile['layer'], 'mode': tile['mode'],
                        'expectedAreaDbu2': expected.area(), 'missingAreaDbu2': missing.area(),
                        'extraAreaDbu2': extra.area()})
    seams = []
    for seam in job.get('seams', []):
        left, right = seam['left'], seam['right']
        key = left['layer']
        clip = clip_box(seam['box'], dbu)
        source = db.Region(cell.begin_shapes_rec_overlapping(indices[key], clip)).merged()
        expected = (source & db.Region(clip)).merged()
        union = (cap_region(coordinates(left), dbu) + cap_region(coordinates(right), dbu)).merged()
        cut = round(seam['x'] / dbu)
        fake_walls = 0
        source_edges = source.edges()
        for tile in [left, right]:
            values = coordinates(tile)
            for offset in range(0, len(values), 9):
                tri = values[offset:offset + 9]
                if tri[2] == tri[5] == tri[8]:
                    continue
                points = {(round(tri[j] / dbu), round(tri[j + 1] / dbu)) for j in (0, 3, 6)}
                if len(points) == 2 and all(point[0] == cut for point in points):
                    a, b = list(points)
                    edge = db.Edges([db.Edge(db.Point(*a), db.Point(*b))])
                    if not (edge - source_edges).is_empty():
                        fake_walls += 1
        seams.append({'layer': key, 'missingAreaDbu2': (expected - union).area(),
                      'extraAreaDbu2': (union - expected).area(), 'fakeInternalWallTriangles': fake_walls})
    failed = [item for item in results if item['missingAreaDbu2'] or item['extraAreaDbu2']]
    bad_seams = [item for item in seams if item['missingAreaDbu2'] or item['extraAreaDbu2'] or item['fakeInternalWallTriangles']]
    return {'passed': not failed and not bad_seams, 'tileChecks': len(results), 'seamChecks': len(seams),
            'nonemptyTileChecks': sum(item['expectedAreaDbu2'] > 0 for item in results),
            'tileFailures': failed, 'seamFailures': bad_seams}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    result = verify(json.loads(Path(args.input).read_text()))
    Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
    raise SystemExit(0 if result['passed'] else 1)
