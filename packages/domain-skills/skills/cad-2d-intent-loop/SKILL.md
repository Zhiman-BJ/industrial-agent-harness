---
name: cad-2d-intent-loop
description: The intent-layer workflow for 2D CAD drawings — spec.json as the single source of truth, ezdxf for authoring DXF artifacts, semantic dxf_diff for absorbing user hand-edits (intent vs appearance classification), silent-overwrite guard, dangling-reference detection, and delivery conversion (vector PDF, DWG via AutoCAD GUI). Use when iterating 2D drawings across turns, absorbing user edits into the spec, regenerating drawings, or delivering DWG/PDF.
---

# 2D intent loop: spec → DXF → absorb → redeliver

Architecture (field-verified): **spec.json is the single source of
truth** (design intent); the DXF is a regenerable artifact; the CAD app is
only display/delivery. Full regeneration from spec beats surgical file edits —
cheap, verifiable, no drift.

## Acceptance gate — always programmatic

`verify.py` reads the final DXF back and scores it against the spec: units,
layers, circles by layer/diameter/center, bolt patterns (radius, spacing,
start angle), dimension actual measurements AND display texts, title texts,
centerline counts. exit 1 = fix loop (cap 5 rounds, archive every FAIL).

Traps already baked into the gate — do not re-introduce:
- radius/diameter ×2 semantics: read back radius×2 and compare against the
  nominal diameter;
- display text vs actual measurement: check BOTH (they can diverge silently);
- ezdxf's built-in "EZDXF" dimstyle carries `dimlfac=100` — override
  `dimlfac=1` or every dimension text is ×100;
- `dimdsep`/`dimdec`: integer mm drawings want `dimdec=0`;
- Ø is `%%c` in DXF text; anchor-match text by ENDING (a substring check
  passes on `%%c12000` when you expect `%%c120`);
- AutoCAD ASCII DXF export loses `×` through the ANSI codepage (survives DWG
  round-trips — DWG is Unicode).

## Absorbing user hand-edits (the diff loop)

1. **BEFORE any regeneration**: semantic-diff the last generated DXF against
   the current file (`scripts/dxf_diff.py a.dxf b.dxf`). Any unexpected diff =
   user edit or corruption — NEVER regenerate silently (silent overwrite of
   user work is the worst failure mode of this architecture).
2. Classify every diff: `intent` (patch the spec) / `appearance` (ignore) /
   `ambiguous` (ask the user; record the options). Appearance-level diffs
   must never enter the spec.
3. **Semantic lift**: four holes rigidly rotated = patch `bolt_start_angle_deg`,
   NOT four hardcoded coordinates. Parameterize the pattern, not the instance.
4. Hand-edits are often internally inconsistent (hole moved, its centerline
   left behind; circle enlarged, its dimension text stale). Detect dangling
   references — a centerline pointing at a circle that moved, a dimension
   whose measurement ≠ its circle — and surface them as must-ask ambiguities.
   Regeneration fixes them from spec; disclose the fix.
5. Archive `spec_before.json` / `spec_after.json` and per-round verify output.

`scripts/dxf_diff.py` (field-tested): clusters CIRCLE by (layer, center, diameter),
LINE by (layer, endpoint set, linetype), TEXT by (content, position),
DIMENSION by (measurement, display text); TOL 1e-3; pairs by entity handle
first (same handle modified = strongest evidence). Same-reader caveat: both
sides parsed with ezdxf — trusted, not independent; for delivery-grade
assurance add one cross-tool readback.

## Delivery conversion

- **PDF**: ezdxf drawing pipeline (`Frontend` + `MatplotlibBackend`,
  `PdfPages`) — vector output, verified.
- **DWG**: NO headless path verified. libredwg 0.14 `dwgwrite` writes corrupt
  DWG (coordinates as −1e20, CJK mojibake) — do not use. Verified path:
  AutoCAD GUI Save As (see cad-autocad-macos: `open -a` to load, AXPress the
  save button, bare filename via `set_value`). ODA File Converter untested.
- DXF→DWG round-trip is lossless for this pipeline's entities (verified;
  `×` and CJK survive); parse converter output with `ezdxf.recover.readfile`.
- **3D deliverables do NOT go through DXF**, and neither do parametric 2D
  sketches the user will keep editing in FreeCAD: both go intent → FCStd
  (3D additionally exports STEP). See cad-freecad-headless.

## Evidence chain

Every claim in a report links the exact command and the raw output file that
backs it. A claim without archived evidence is treated as false.
