"""Cooperative self-RSS guard; it cannot interrupt a running native operation."""
import math
import sys

try:
    import resource
except ImportError:
    resource = None

MAX_RSS_BYTES = 768 * 1024 * 1024
if '--max-rss-bytes' in sys.argv:
    MAX_RSS_BYTES = int(sys.argv[sys.argv.index('--max-rss-bytes') + 1])
    if MAX_RSS_BYTES <= 0:
        raise ValueError('Invalid worker memory budget.')


class MemoryBudgetError(RuntimeError):
    pass


def resource_status():
    if resource is None or sys.platform not in ('darwin', 'linux'):
        return {'peakRssBytes': None, 'monitor': 'unavailable'}
    try:
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    except (OSError, ValueError):
        return {'peakRssBytes': None, 'monitor': 'unavailable'}
    if not math.isfinite(peak) or peak <= 0:
        return {'peakRssBytes': None, 'monitor': 'unavailable'}
    scale = 1 if sys.platform == 'darwin' else 1024
    return {'peakRssBytes': int(peak * scale), 'monitor': 'self-rss'}


def check_resources():
    status = resource_status()
    if status['peakRssBytes'] is not None and status['peakRssBytes'] > MAX_RSS_BYTES:
        raise MemoryBudgetError('KLayout worker exceeded its memory budget. Retry a smaller viewport.')
    return status
