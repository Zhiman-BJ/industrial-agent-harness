#!/usr/bin/env python3
"""Bounded old-geometry baseline, in fresh processes, with an exact XY oracle.

The runner reads fixtures only and prints summaries, never large mesh arrays.
--geometry-dir may point to a frozen baseline copy while production evolves.
"""
import argparse
import hashlib
import json
import math
import platform
import resource
import subprocess
import sys
import time
from pathlib import Path


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def rss_bytes():
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(value if sys.platform == 'darwin' else value * 1024)


def worker(request):
    import klayout.db as db
    sys.path.insert(0, request['geometryDir'])
    from geometry import extract_geometry
    file = request['file']
    result = {'fixture': request['fixture'], 'case': request['case'], 'box': request['box'],
              'sourceSha256': digest(file), 'klayoutVersion': db.__version__}
    started = time.monotonic()
    layout = db.Layout()
    layout.read(file)
    cell = layout.top_cell()
    result['loadSeconds'] = round(time.monotonic() - started, 6)
    result['loadPeakRssBytes'] = rss_bytes()
    indices = {f'{layout.get_info(i).layer}/{layout.get_info(i).datatype}': i
               for i in layout.layer_indices()}
    started = time.monotonic()
    try:
        geometry = extract_geometry(layout, cell, {'token': 'stress-baseline',
                                                  'box': request['box'], 'visible': list(indices)})
        result.update({'status': 'exact', 'shapeCount': geometry['shapeCount'],
                       'triangleCount': geometry['triangleCount'], 'returnedLayers': len(geometry['layers'])})
    except Exception as error:
        geometry = None
        result.update({'status': 'rejected', 'error': str(error), 'errorType': type(error).__name__})
    result['extractSeconds'] = round(time.monotonic() - started, 6)
    result['extractPeakRssBytes'] = rss_bytes()
    if geometry:
        started = time.monotonic()
        dbu = layout.dbu
        box = request['box']
        clip = db.Box(math.ceil(box[0] / dbu), math.ceil(box[1] / dbu),
                      math.floor(box[2] / dbu), math.floor(box[3] / dbu))
        clip_region = db.Region(clip)
        meshes = {item['key']: item['triangles'] for item in geometry['layers']}
        checks = []
        for key, index in indices.items():
            expected = (db.Region(cell.begin_shapes_rec_overlapping(index, clip)) & clip_region).merged()
            projected = db.Region()
            vertices = meshes.get(key, [])
            for offset in range(0, len(vertices), 9):
                tri = vertices[offset:offset + 9]
                if tri[2] == tri[5] == tri[8] == 1:
                    projected.insert(db.Polygon([db.Point(round(tri[j] / dbu), round(tri[j + 1] / dbu))
                                                 for j in (0, 3, 6)]))
            projected.merge()
            missing = expected - projected
            extra = projected - expected
            checks.append({'layer': key, 'expectedAreaDbu2': expected.area(),
                           'missingAreaDbu2': missing.area(), 'extraAreaDbu2': extra.area()})
        result['xyOracle'] = {'passed': all(item['missingAreaDbu2'] == item['extraAreaDbu2'] == 0 for item in checks),
                              'checkedLayers': len(checks), 'nonemptyLayers': sum(item['expectedAreaDbu2'] > 0 for item in checks),
                              'missingAreaDbu2': sum(item['missingAreaDbu2'] for item in checks),
                              'extraAreaDbu2': sum(item['extraAreaDbu2'] for item in checks)}
        result['oracleSeconds'] = round(time.monotonic() - started, 6)
    result['peakRssBytes'] = rss_bytes()
    result['sourceUnchanged'] = digest(file) == result['sourceSha256']
    print(json.dumps(result), flush=True)


def run(args):
    manifest = json.loads(Path(args.manifest).read_text())
    geometry_dir = str(Path(args.geometry_dir).resolve())
    report = {'platform': platform.platform(), 'python': sys.version.split()[0],
              'geometrySha256': digest(Path(geometry_dir) / 'geometry.py'),
              'manifest': str(Path(args.manifest).resolve()), 'maxCaseWallSeconds': args.timeout,
              'cases': []}
    for fixture in manifest['fixtures']:
        for label in ['full', 'detail', 'seam']:
            request = {'fixture': fixture['name'], 'file': fixture['path'], 'case': label,
                       'box': fixture['boxes'][label], 'geometryDir': geometry_dir}
            started = time.monotonic()
            try:
                process = subprocess.run([sys.executable, __file__, '--worker', json.dumps(request)],
                                         capture_output=True, text=True, timeout=args.timeout)
                if process.returncode:
                    result = {'fixture': fixture['name'], 'case': label, 'status': 'worker-failed',
                              'exitCode': process.returncode, 'stderr': process.stderr[-2000:]}
                else:
                    result = json.loads(process.stdout.strip().splitlines()[-1])
                    if process.stderr.strip():
                        result['readerWarnings'] = process.stderr.strip()[-2000:]
            except subprocess.TimeoutExpired:
                result = {'fixture': fixture['name'], 'case': label, 'status': 'wall-timeout',
                          'error': 'Worker killed by the benchmark wall-time bound.'}
            result['wallSeconds'] = round(time.monotonic() - started, 6)
            report['cases'].append(result)
            print(json.dumps({key: result.get(key) for key in ['fixture', 'case', 'status', 'shapeCount',
                                                               'triangleCount', 'extractSeconds', 'peakRssBytes', 'error']}), flush=True)
            Path(args.output).write_text(json.dumps(report, indent=2) + '\n')
    failures = [item for item in report['cases'] if item['status'] in ['wall-timeout', 'worker-failed']
                or item.get('sourceUnchanged') is False or item.get('xyOracle', {}).get('passed') is False]
    return 1 if failures else 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest')
    parser.add_argument('--geometry-dir')
    parser.add_argument('--output')
    parser.add_argument('--timeout', type=float, default=20)
    parser.add_argument('--worker')
    args = parser.parse_args()
    if args.worker:
        worker(json.loads(args.worker))
    else:
        if not all([args.manifest, args.geometry_dir, args.output]):
            parser.error('--manifest, --geometry-dir and --output are required')
        sys.exit(run(args))
