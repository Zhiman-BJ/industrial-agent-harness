# STEP component importer

The offline PCB component loader uses **occt-import-js 0.0.23**, by Viktor Kovacs
and contributors, under LGPL 2.1. Its Open CASCADE dependency is licensed under
LGPL 2.1 with the accompanying OCCT exception. The original license files are
included here. The official npm package's JS and WASM files are unchanged.
The generated Emscripten runtime is Copyright the Emscripten authors under
MIT or University of Illinois/NCSA terms; the 3.1.69 license is included as
`EMSCRIPTEN-LICENSE.txt`.

Corresponding source is distributed in:

- `source/occt-import-js-c2148e5.tar.gz`: complete upstream wrapper, build
  scripts, examples, and tests at `c2148e54b456b571238d35cac037d304053d64b2`.
- `source/OCCT-d2abb6d.tar.gz`: complete, unmodified OCCT submodule source at
  `d2abb6d844231cb8f29be6894440874a4700e4a5`.

The manifest records the original package integrity and every distributed
upstream file's SHA-256. Upstream uses Emscripten 3.1.69; its build instructions
and scripts are included in the wrapper source archive. Users may modify,
rebuild, debug, and replace these separately loaded parser files.

Harness makes one runtime adaptation in the distributed
`../../component-wasm.js` source: after validating the pinned WASM hash and its
single internal memory section, it re-encodes that section's maximum from
32768 to 4096 pages (2048 MiB to 256 MiB), preserving the 457-page initial
memory. The original vendored binary remains unchanged. Unrecognized parser
binaries fail closed; a modified replacement can be paired with an updated
source manifest and adaptation. This limits **WASM linear memory only**.
JavaScript parser output also has mesh budgets, and each parse runs in a
terminable Worker with a deadline; these are not an operating-system process
memory guarantee.

Sources:
https://github.com/kovacsv/occt-import-js
https://github.com/Open-Cascade-SAS/OCCT
