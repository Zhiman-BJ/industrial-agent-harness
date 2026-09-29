# Godot Viewer Playground

This original example contains a moving pixel robot, a runtime clock and a Camera2D. It demonstrates runtime viewing and local asset inspection, without requiring an Agent or model API.

Install Godot 4 with matching Web export templates, then run from the repository root:

```sh
node examples/godot-viewer/export.cjs
```

Use `GODOT_BIN` if the executable is not named `godot`. The script copies the repository's current Viewer Bridge, imports textures and creates a single-threaded Web export in the ignored `build/` directory. It must succeed before opening the project in Godot or viewing the export.

Create a project bound to this folder with domain **Godot**, open the workspace and file tree, then select:

- `build/playground.html`: the real Godot runtime. Pause freezes the clock and robot; Step advances one display frame; Play resumes; Stop resets the scene. Select Robot to inspect it or MainCamera in the Camera selector.
- `robot.png`: image zoom, pan and background.
- `robot.sprite.json`: four-column sprite slicing and idle/run animation.
- `playground.tscn`: read-only animation preview from the embedded SpriteFrames resource. This preview does not execute the scene script.

All scene code and pixel graphics in this folder are authored for this repository. Export binaries and Godot import caches are generated locally and are not checked in. Viewer controls and snapshots do not verify an engineering result.
