---
name: cad-freecad-headless
description: Driving FreeCAD headless via freecadcmd for parametric 2D sketches and 3D solids — Sketcher constraint traps (DistanceAngle segfault, Angle 180° offset), env-var JSON readback, fully-constrained gate, analytic volume verification, model-driven interference checks, STEP roundtrip. Use when building, editing, or verifying FreeCAD models (2D or 3D) without a GUI, writing build/readback/verify scripts, or debugging freecadcmd crashes.
---

# FreeCAD headless (freecadcmd): operating traits

Scope: FreeCAD driven without a GUI — parametric 2D sketches and 3D solids
alike; this skill is dimension-neutral. Route by deliverable, not by tool:
2D drawing files go to direct ezdxf authoring (cad-ezdxf — FreeCAD's
TechDraw→DXF chain is a known weak link for drawing delivery and was rejected
in the field); parametric 2D sketches the user will keep editing in FreeCAD,
and 3D models, go FCStd (3D additionally exports STEP). Everything here is
verified on 1.1.3 (R20260725) — version-lock FreeCAD and record the exact
version, the Sketcher API differs across 0.2x/1.x.

## Platform facts (verified)

- `freecadcmd` lives inside the app bundle, not on PATH:
  `/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd`. First run may
  hit Gatekeeper: `xattr -d com.apple.quarantine /Applications/FreeCAD.app`.
- Scripts execute inside FreeCAD's own Python; you cannot `import FreeCAD`
  from the system Python on macOS. Cold start is a few seconds — batch
  per-task is fine at POC scale; consider a persistent session later.
- Length unit is mm throughout; Sketcher angle values in the Python API are
  RADIANS (the UI shows degrees — a recurring ×180 confusion).
- freecadcmd swallows tracebacks: a crashing script prints `Unknown exception`
  or segfaults (exit 139) with no stack. Debug by bisecting with tiny probe
  scripts; a log stuck at START means the script aborted — don't assume it ran.

## Build → readback → verify: the intent loop's FreeCAD form

The loop itself is defined in cad-intent-loop (spec → artifact → absorb →
verify); here is its freecadcmd form — the only trusted pattern:

1. **Build** with an idempotent script → save FCStd + export STEP. Log
   START/stages/END to a file (same discipline as LISP).
2. **Readback**: run a readback script under freecadcmd that opens the FCStd
   and dumps JSON (env-var driven: `FC_FILE`, `FC_OUT`, `FC_SLICES`): per
   sketch — geometry list (type/center/radius/construction flag), constraint
   list (type+value), `fully_constrained`; per solid — `Shape.Volume`,
   BoundBox, cylinder-face census (radius/center/axis/height), torus faces,
   slice wire counts at chosen z heights.
3. **Verify**: spec-driven checks against that JSON. Every check is
   model-driven — judge the geometry that was read back, never what the build
   script claims. Shared verify/readback tools stay read-only; task-specific
   extensions live in the task dir.

## Permanent quality gates (field-tested)

- **Every sketch fully constrained.** Under-constrained = design not fully
  defined → FAIL. Keep a DOF ledger when writing constraints (3 DOF per
  circle; count constraints against it to avoid redundancy before solving).
- **Volume vs closed-form analytic** within 1%. Prefer exact circle-circle
  intersection formulas over numeric integration (a numeric integration was
  measurably off on a real part and shipped as a wrong "truth").
- **Cylinder-face census is an interference witness**: a pierced groove shows
  as N broken arc faces on its wall radius; a clean groove as 1 continuous
  ring. Slice wire counts at a z inside the feature band catch topological
  breaks (e.g. 12 wires = outer rim + 8 holes + 2 groove walls, unbroken).
- **Self-consistency/interference preflight BEFORE building** (e.g. bolt-hole
  vs groove radial clearance ≥ 0.5 mm). Make it a permanent spec check, and
  prove it has teeth: run it against a known-bad design — it must FAIL.
  A check that cannot fail is decoration.
- **Do not filter cylinder faces by axis sign**: Pad produces `[0,0,1]` and
  `[0,0,-1]` axes depending on the feature; filter by radius/center only.
- **STEP roundtrip check**: `Part.read` (NOT `App.openDocument` — it rejects
  .step), then solids/volume/faces/`isValid()`. FreeCAD's own DXF importer is
  geometry-oriented: dimension blocks degrade or drop — never use FreeCAD
  import as the acceptance reader for DXF files; use ezdxf.

## Sketcher API traps (verified on 1.1.3)

- `Sketcher.Constraint("DistanceAngle", ...)` **segfaults the process** —
  syntax is legal, docs exist, the binding crashes. Same for several
  `Angle(-1, 2, ...)` point-form variants (or the solver stalls, solve()=−5).
  Workaround: per feature, a construction radial line (origin → hole center)
  + 2× Coincident + `Distance` + `Angle` + `Diameter`; DOF ledger balances.
- `Angle(-1, 2, line, 1, a)` applies **a+180° (mod 360)** — calibrate with a
  probe and fixate the offset in the build script.
- `FreeCAD.math` does not exist — use stdlib `math`.
- `PartDesign` Pad on a multi-wire sketch: inner wires become holes; if the
  solid comes out wrong, check wire orientation / `Pad.Reversed`.
