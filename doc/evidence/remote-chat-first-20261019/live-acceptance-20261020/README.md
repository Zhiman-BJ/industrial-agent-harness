# Live remote chat acceptance — 2026-10-20

The final run passed at `2026-10-20T05:24:25.669Z`. The local model fixture drove real Kimi 2.1.1 and TaskService against the deployed remote service. Only model responses were mocked. This is a headless service integration acceptance, not an Electron click test or a test of autonomous model reasoning.

`acceptance.json` was written only after `await tasks.close()` succeeded. The outer runner subsequently logged out the memory-only account and exited with code 0. Its two CAD actions were `942a41b3-b7c0-46d0-86d3-ea4b1a7e532e` and `1081d29e-0aee-495f-9faa-60a8c66ba787`.

- Chat creation and the immutable file/tool plan preceded upload.
- One batch approval covered the destination, exact file and task tool scope. One additional approval covered the exact local file edit: two approval prompts in total, with no separate remote-tool prompt.
- The changed file produced a different snapshot and input hash before the second execution, without another plan or preparation approval.
- Both CAD actions passed the actual independent geometry verifier. Every imported artifact's bytes and size were checked against its canonical reference; the model read a real report and reported both actual action IDs.
- Preparation and both engineering sessions were released.

The structured excerpts retain actual IDs, hashes, metrics, decisions and receipts. `provenance.json` records source-file hashes and transformations. Host temporary-root paths are replaced by `<test-root>`. CAD readback/execution report copies retain their original bytes. `approval-evidence.json` joins final decisions to their pre-decision previews by ID; the preview capture's initial defensive `reject` placeholder is not used as the decision. No login code, token, model key or account identity is included.

An earlier independent run had also completed both CAD actions, but the qualification script mistakenly expected `completion.status === 'completed'`; TaskService forwards Kimi's `finished` status. That assertion was corrected, and this new project exercised all final assertions and cleanup successfully. No uncertain remote request was replayed.

This evidence covers one synthetic CAD geometry task on the deployed test service from macOS. It does not qualify every domain, a full installer, other host platforms, or a production model service.
