---
name: computer-use
description: Drive GUI applications on the user's Mac through the computer-use tools (list_apps, get_app_state, click, type_text, set_value, screenshot, zoom). Look -> act -> verify. Field-tested discipline for focus loss, IME, file dialogs, stuck prompts, and long multi-step sessions.
---

# Computer Use

You can operate the user's desktop apps. Use the look -> act -> verify loop, and treat the
artifacts on disk (saved files, logs, verification output) as the record, not the screen.

## Permissions (first run)

The first real capture or accessibility call triggers a macOS permission prompt; grant
Screen Recording & Accessibility for the host app (System Settings → Privacy & Security;
macOS 27 renames the accessibility pane to 设备控制和数据访问). If a capture fails with a
permission error and no prompt appears, add the host app manually in the Screen Recording
list, then restart the app.

## Protocol

1. `list_apps` first to get the exact `app` value. Then `get_app_state` to read the
   accessibility tree; interactive elements carry ids like `e12`.
2. Act on element ids from the most recent snapshot, not coordinates. Coordinates only
   for canvas/custom widgets the tree does not expose; convert screenshot pixels to
   screen points using the mapping in the capture result.
3. After acting, the tree has changed: call `get_app_state` again. Element ids are
   per-snapshot; a stale id fails.

## Focus is the #1 failure mode — verify after every input burst

Background clicks do NOT deliver keystrokes when the target app is not frontmost;
`type_text` can report success while the field is unchanged or shows a doubled/garbled
remnant of an earlier attempt. For every input:

1. `activate_app` if the target is not frontmost, then `click` the input field to set focus.
2. `type_text` one logical chunk — or prefer `set_value` for a whole field (below).
3. `zoom` the field region and read the pixels before pressing Enter. The accessibility tree
   lags and lies (it can show a cleared field while the real command line is dirty, and
   vice versa); `zoom` is the source of truth for short on-screen text, `get_app_state`
   for structural state (dialogs, buttons).
4. Only then press Enter / Save.

Budget ~4 tool calls per input. Blind multi-step input wastes 10x more.

## File dialogs: prefer `set_value` over typing

- `set_value <field-id> <value>` writes the whole string in one accessibility call — immune
  to focus loss, IME, and per-keystroke drops. Verified with 95-char paths, zero loss.
- Fill the **bare filename** when the dialog's location field already points at the right
  directory; some apps mangle typed absolute paths (e.g. turning `/` into `:`, producing a
  literal `:Users:foo:bar.dxf` file). A bare filename sidesteps the bug entirely.
- After Save, expect a replace/overwrite sheet: `get_app_state query=replace` (or the
  localized 替换/OK), click it, then confirm the file on disk (`ls`, timestamp check).
- For a format selector: click the PopUpButton, `get_app_state query=<format>`, click the
  wanted item, and re-check the button value before saving (the first click can miss).

## IME (Chinese input method)

Chinese IMEs swallow or remap typed characters — even ASCII can pass through in
unpredictable forms. Before any serious typing session:

- Switch to the US/ABC layout (System Settings, or any TIS input-source helper) and verify
  by typing 3 characters into the target and `zoom`-ing the field. Use the FULL
  input-source id (`com.apple.keylayout.ABC`), not a short hint — helpers silently no-op
  unknown ids while printing "switched". The reported "current" value can also lag reality.
- If text keeps vanishing despite a correct report, restart the IME process
  (`killall SogouInput` etc.) as a fallback.
- **The user may switch the IME back between pauses.** Re-check at the start of every
  working burst, not just once at the beginning.

## Clipboard fallback

`clipboard_write <text>` then click the field and `press_key cmd+v` is one atomic delivery
of a whole string — no per-keystroke drops. It overwrites the user's clipboard; tell them
if it held something non-trivial. Paste still needs the `zoom` verification (focus can
drop mid-flow).

## Stuck prompts and modals

- If an app sits at a "select object"-style prompt that ignores Escape: make it frontmost,
  click the input field, try Escape; if still stuck, press Enter — an empty selection often
  terminates or advances the loop harmlessly. Do not queue more commands while a prompt is
  live; they are silently consumed (this is how doubled-command states get created).
- Hidden modal sheets swallow keystrokes aimed at the main window. If input goes nowhere,
  `get_app_state` without a window scope and look for extra windows (security prompts,
  replace sheets, file dialogs), then click through them.

## Coordinates

`screenshot`/`zoom` results report screen origin (points) and px-per-pt. To act on a point
seen in the image: `x = originX + px / pxPerPt`, `y = originY + py / pxPerPt` — click in
POINTS, not pixels. `zoom` also returns the mapping for its own region.

## Long-task discipline

- After each significant step, the artifact on disk is the record; name verification
  outputs per round (`verify_output_roundN.txt`). A probe log that stops after START
  without END means the script aborted mid-way — treat as failure, do not assume it ran.
- Keep a compact "facts so far" model: proven dead-ends (do not retry), proven-reliable
  inputs, current dirty state of the app. Restate it after every compaction or
  interruption.
- After an interruption, re-inspect the app state (windows, command line via `zoom`) before
  continuing; do not assume the pre-pause state. The user may have closed windows, switched
  IME, or left commands half-typed.

## Safety

Read the target with `get_app_state` before destructive actions. Deleting files, sending
messages, or irreversible app actions still need the user's explicit confirmation even though
the plugin is enabled. Prefer the narrowest action that makes the step verifiable.
