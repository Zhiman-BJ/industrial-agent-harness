// Boards produced by KiCad always declare their stack in a (layers ...) block,
// but minimal hand-written or generator-produced sources may omit it. The
// upstream board renderer resolves every referenced layer by name and crashes
// with an opaque "reading 'visible'" TypeError when the block is missing, so
// synthesize the standard two-layer definition before parsing. The source is
// only normalized for rendering; the on-disk bytes and SHA-256 stay untouched.

// Mirrors the layer table emitted by pcbnew 10 for a two-layer board.
const DEFAULT_LAYERS_BLOCK = `(layers
    (0 "F.Cu" signal)
    (2 "B.Cu" signal)
    (9 "F.Adhes" user "F.Adhesive")
    (11 "B.Adhes" user "B.Adhesive")
    (13 "F.Paste" user)
    (15 "B.Paste" user)
    (5 "F.SilkS" user "F.Silkscreen")
    (7 "B.SilkS" user "B.Silkscreen")
    (1 "F.Mask" user)
    (3 "B.Mask" user)
    (17 "Dwgs.User" user "User.Drawings")
    (19 "Cmts.User" user "User.Comments")
    (21 "Eco1.User" user "User.Eco1")
    (23 "Eco2.User" user "User.Eco2")
    (25 "Edge.Cuts" user)
    (27 "Margin" user)
    (31 "F.CrtYd" user "F.Courtyard")
    (29 "B.CrtYd" user "B.Courtyard")
    (35 "F.Fab" user)
    (33 "B.Fab" user)
    (39 "User.1" user)
    (41 "User.2" user)
    (43 "User.3" user)
    (45 "User.4" user)
  )`;

const BOARD_HEADER = /^\s*\(kicad_pcb\b/;
const LAYERS_BLOCK = /\(\s*layers[\s)]/;
const GENERATOR_CLAUSE = /\(generator(?:_version)?\s+(?:"[^"]*"|[^()\s]+)\)/;
const VERSION_CLAUSE = /\(version\s+\d+\)/;

export function boardDeclaresLayers(source) {
  return LAYERS_BLOCK.test(source);
}

export function ensurePcbLayersBlock(source) {
  if (typeof source !== 'string' || !BOARD_HEADER.test(source)) return source;
  if (boardDeclaresLayers(source)) return source;
  const anchor = GENERATOR_CLAUSE.exec(source) || VERSION_CLAUSE.exec(source);
  if (!anchor) return source;
  const at = anchor.index + anchor[0].length;
  return `${source.slice(0, at)}\n  ${DEFAULT_LAYERS_BLOCK}${source.slice(at)}`;
}
