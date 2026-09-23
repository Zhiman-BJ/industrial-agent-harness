# Surfer snapshot

The unmodified `surfer.js`, `surfer_bg.wasm`, and `integration.js` were downloaded from https://app.surfer-project.org/ on 2026-09-16. See ASSET-MANIFEST.json for URLs, file sizes and SHA-256 digests. The JavaScript and WASM hashes match the official site's HTML subresource integrity attributes at download time.

Surfer source and copyright holders: https://gitlab.com/surfer-project/surfer
Surfer is distributed under EUPL-1.2. The full license is included as LICENSE-EUPL-1.2.txt (standard text from the SPDX license list).

The `index.html`, `embed.css` and `bridge.js` in this directory are the demo integration adapter. The official JavaScript and WASM were not modified. The adapter replaces the official top-level HTML, omits the PWA/service worker, embeds the viewer locally, limits its host communication, and exposes a small message bridge. Source for all adapter modifications is included here.

For the original application, dependencies and corresponding source, consult the Surfer project. Upstream messages and state formats can change; this demo pins the binary snapshot by content hashes.

Harness integration: these assets were copied from the user-supplied silicon-viewer-demo.zip. The upstream download and SRI statement above is retained from that demo; this integration checks the retained SHA-256 hashes locally. The bridge additionally permits an explicitly configured localhost development parent origin.
