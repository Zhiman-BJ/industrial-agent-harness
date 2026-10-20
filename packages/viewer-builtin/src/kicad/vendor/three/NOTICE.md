# Three.js PCB renderer dependencies

Three.js 0.160.1, OrbitControls, and VRMLLoader are redistributed under the MIT license retained in `LICENSE`.

Upstream: https://github.com/mrdoob/three.js/tree/r160
Pinned distribution URLs and original/file SHA-256 digests are in `manifest.json`.
VRMLLoader and its Chevrotain bundle come from the official `r160` tag, commit `d04539a76736ff500cae883d6a38b3dd8643c548`.

`three.module.js` and `LICENSE` are unchanged distribution files.
`controls/OrbitControls.js` and `loaders/VRMLLoader.js` each change only their module import from `three` to `../three.module.js` so the isolated offline Viewer does not require an inline import map or a relaxed Content Security Policy.
`loaders/VRMLLoader.js` retains its upstream relative import of `../libs/chevrotain.module.min.js`.

## Chevrotain

`libs/chevrotain.module.min.js` is the unchanged Chevrotain 9.0.1 bundle distributed by Three.js r160. Chevrotain is licensed under Apache-2.0; its complete license and upstream notice are retained in `libs/chevrotain-LICENSE.txt` and `libs/chevrotain-NOTICE.txt`.

Copyright (c) 2015-2019 SAP SE or an SAP affiliate company.

Chevrotain upstream: https://github.com/Chevrotain/chevrotain/tree/v9.0.1

The bundle also includes regexp-to-ast 0.5.0, licensed under MIT, copyright (c) 2018 Shahar Soel. Its complete license is retained in `libs/regexp-to-ast-LICENSE`.

regexp-to-ast upstream: https://github.com/bd82/regexp-to-ast/tree/v0.5.0

## Integration boundary

VRMLLoader is a display parser. This vendor directory includes no industrial executable or engineering verifier. Its upstream loading methods can request external resources; callers must enforce the Viewer's file, resource, and execution budgets and offline resource policy before parsing untrusted models.

The PCB wrapper accepts bounded static triangle meshes and blocks active nodes and external resources before calling `parse`. It adapts validated KiCad `DEF`/`USE` identifiers for the upstream lexer's hyphen limitation without changing this vendored loader. Unsupported transforms and ambiguous KiCad WRL unit conventions fail explicitly. Display materials retain diffuse/vertex colors, transparency, and sidedness; they do not reproduce KiCad's complete lighting model.

The unchanged Chevrotain bundle contains an unreachable `eval` statement after an unconditional `return` in its `toFastProperties` helper. This integration does not execute it or enable CSP `unsafe-eval`.
