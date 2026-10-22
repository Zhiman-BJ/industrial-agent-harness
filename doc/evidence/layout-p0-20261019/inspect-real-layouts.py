#!/usr/bin/env python3
"""Read existing local chip artifacts and select a populated display ROI."""
import hashlib
import importlib.util
import json
import argparse
import os
import subprocess
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', default='-', help='Manifest output path; default: stdout (historical evidence is not overwritten).')
parser.add_argument('--check-inputs', action='store_true', help='Only resolve inputs and verify manifest hashes; do not parse geometry.')
args = parser.parse_args()
loaded = subprocess.run(
    [os.environ.get('NODE_BINARY', 'node'), str(Path(__file__).with_name('load-layout-inputs.cjs')), '--json'],
    check=True, capture_output=True, text=True,
)
inputs = json.loads(loaded.stdout)
if args.check_inputs:
    print(json.dumps({'status': 'source-hashes-verified', 'fixtures': [
        {key: fixture[key] for key in ('name', 'sourceRef', 'bytes', 'sha256')}
        for fixture in inputs['fixtures']]}, indent=2))
    sys.exit(0)
import klayout.db as db
spec = importlib.util.spec_from_file_location('fixture_stats', ROOT / 'packages/viewer-builtin/tests/tools/generate-layout-stress.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
manifest = {'scope': 'Existing local chip artifacts, separate from synthetic stress fixtures',
            'klayoutVersion': db.__version__, 'fixtures': []}
for subject in inputs['fixtures']:
    name, path = subject['name'], Path(subject['path'])
    source_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    assert source_hash == subject['sha256'], f'Source changed after manifest check: {name}'
    layout = db.Layout()
    layout.read(str(path))
    cell, bounds = layout.top_cell(), layout.top_cell().dbbox()
    cx, cy = round(bounds.center().x, 3), round(bounds.center().y, 3)
    detail = [round(cx - 5, 3), round(cy - 5, 3), round(cx + 5, 3), round(cy + 5, 3)]
    clip = db.Box(*(round(value / layout.dbu) for value in detail))
    layer_details = []
    for index in layout.layer_indices():
        info = layout.get_info(index)
        iterator = cell.begin_shapes_rec_overlapping(index, clip)
        scanned = 0
        while not iterator.at_end() and scanned <= 5000:
            scanned += 1
            iterator.next()
        if scanned > 5000:
            raise RuntimeError(f'ROI too dense for bounded independent audit: {name} {info}')
        source = (db.Region(cell.begin_shapes_rec_overlapping(index, clip)) & db.Region(clip)).merged()
        layer_details.append({'key': f'{info.layer}/{info.datatype}', 'overlappingRecords': scanned,
                              'mergedPolygons': source.size(), 'areaDbu2': source.area(),
                              'coverage': source.area() / clip.area()})
    patterned = [item for item in layer_details if 0.03 < item['coverage'] < 0.8 and item['mergedPolygons'] > 2]
    patterned.sort(key=lambda item: item['mergedPolygons'], reverse=True)
    fixture = {'name': name, 'kind': 'existing-chip-artifact', 'path': subject['sourceRef'], 'bytes': path.stat().st_size,
               'sha256': source_hash, 'cell': cell.name, 'dbu': layout.dbu,
               'boxes': {'full': [bounds.left, bounds.bottom, bounds.right, bounds.top], 'detail': detail, 'seam': detail},
               'stats': module.statistics(layout, cell), 'roiLayers': layer_details,
               'patternedLayerCandidates': [item['key'] for item in patterned]}
    if subject.get('pathEnv'):
        fixture['pathEnv'] = subject['pathEnv']
    assert hashlib.sha256(path.read_bytes()).hexdigest() == source_hash
    manifest['fixtures'].append(fixture)
    print(json.dumps({key: fixture[key] for key in ('name', 'cell', 'stats', 'boxes', 'patternedLayerCandidates')}), file=sys.stderr)
output = json.dumps(manifest, indent=2) + '\n'
if args.output == '-':
    sys.stdout.write(output)
else:
    Path(args.output).write_text(output)
