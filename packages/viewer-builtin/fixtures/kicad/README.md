# KiCad viewer fixtures

`pads.kicad_pcb` and `symbols.kicad_sch` are unchanged copies of `test/kicad/files/footprint-pads.kicad_pcb` and `test/kicad/files/symbols.kicad_sch` from https://github.com/theacodes/kicanvas at commit `b031159eb74aaa7eef2b026fd85d35bc05ff2095`.

They are KiCad 6 geometry test inputs (PCBNew/Eeschema generators), used for real parser and canvas validation. They are synthetic upstream test artifacts, not engineering acceptance evidence or product example projects. The upstream license/third-party notices are retained in `LICENSE.md` and the runtime's `src/kicad/vendor/` directory.

`hierarchy.kicad_sch` is a Harness-authored minimal hierarchical schematic. The desktop test places a copy of `symbols.kicad_sch` at its referenced `sub/child.kicad_sch` path to verify multi-source rendering and companion hash invalidation.
