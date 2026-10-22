# Constructed artifact demonstrations (internal)

The replay composition presents the production `AgentFlow` conversation renderer
next to the production `ViewerCanvas`. Its task is read-only presentation of
recorded or explicitly authored events. It never creates the live application's
TaskService, model, Broker or industrial runtime.

A constructed demonstration is visibly identified as **构造演示**. Its authored
narration is not represented as a real model run, and finishing the presentation
is not electrical, DRC, manufacturing or engineering acceptance. This distinction
also applies to screenshots and videos used in reports.

## Build a snapshot demonstration

Render the desired stages using the real artifact renderer. Keep the camera fixed
across stages, save each as a PNG, and retain the native sources and provenance
alongside them. The following input describes the presentation:

```json
{
  "title": "Development board · staged 3D assembly",
  "recordingId": "constructed-devboard",
  "prompt": "Show the development board taking shape, from substrate to assembly.",
  "stages": [
    {
      "id": "board",
      "title": "Board body and mounting holes",
      "description": "Constructed geometry stage, before component bodies.",
      "imagePath": "snapshots/board.png",
      "componentCount": 0
    },
    {
      "id": "assembly",
      "title": "Component assembly",
      "description": "A fixed-camera render of the final demonstration geometry.",
      "imagePath": "snapshots/assembly.png",
      "componentCount": 63
    }
  ]
}
```

```bash
node scripts/build-staged-demo.cjs /absolute/path/to/stages.json /absolute/path/to/new-replay-bundle
node apps/desktop/internal/replay/launch.cjs --replay /absolute/path/to/new-replay-bundle
```

The builder refuses existing destinations, copies immutable snapshots, records
their hashes and creates an ordinary recording bundle. Its events contain authored
text and presentation status, without fabricated tool execution or industrial
verification results. Default stage duration is five seconds, so six stages form
a 30-second progression. Seek/reset select the corresponding historical snapshot.

## Passive snapshot boundary

`manifest.replayStages` binds each stage to an ordered source event sequence and
a declared image asset. Replay-only IPC accepts that asset identity; it cannot
open arbitrary paths. `readReplayImage` rechecks path containment, symlinks,
size, SHA256, PNG signature and dimensions before sending a data URL. Images
are capped at 16 MiB, 8192 pixels per dimension and 32 million pixels total.
SVG, HTML, executable viewers, source scripts and automatic downloads are not
accepted on this path.

Snapshots are rendered by the existing product image Viewer. A fixed-camera PNG
of a 3D artifact is a snapshot, not an interactive 3D session. Native boards and
model assets can separately be opened in the existing KiCad Viewer through the
ordinary project flow; this presentation does not invent absent project files.

The complete source-event ledger remains accessible as diagnostics, while the
primary replay layout is the product conversation flow and artifact Viewer.
Public application entrypoints do not import the internal replay composition.
