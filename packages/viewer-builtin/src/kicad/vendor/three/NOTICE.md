# Three.js PCB renderer dependencies

Three.js 0.160.1 and OrbitControls are redistributed under the MIT license retained in `LICENSE`.

Upstream: https://github.com/mrdoob/three.js/tree/r160
Pinned distribution URLs and original/file SHA-256 digests are in `manifest.json`.

`three.module.js` and `LICENSE` are unchanged distribution files.
`controls/OrbitControls.js` changes only its module import from `three` to `../three.module.js` so the isolated offline Viewer does not require an inline import map or a relaxed Content Security Policy.
No source parser, remote service, or domain tool is included.
