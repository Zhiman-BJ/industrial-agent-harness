---
name: computer-use
description: Drive GUI applications on the user's Mac through the computer-use tools (get_app_state, click, type_text, set_value, screenshot, zoom). Look -> act -> verify. Field-tested discipline for focus loss, file dialogs, IME, and stuck prompts.
---

# Computer Use

You can operate the user's desktop apps. Use the look -> act -> verify loop, and treat the
artifacts on disk (saved files, logs, verification output) as the record, not the screen.

## Protocol

1. `list_apps` first to get the exact `app` value. Then `get_app_state` to read the
   accessibility tree; interactive elements carry ids like `e12`.
2. Act on element ids from the most recent snapshot, not coordinates. Coordinates only
   for canvas/custom widgets the tree does not expose; convert screenshot pixels to
   screen points using the mapping in the capture result.
3. After acting, the tree has changed: call `get_app_state` again. Element ids are
   per-snapshot; a stale id fails.

## Focus is the failure mode — verify after every input burst

A background click that does not reach the focused app silently drops keystrokes; `type_text`
can report success while the field is unchanged or shows a doubled remnant. For every input:

1. `activate_app` if the target is not frontmost, then `click` the input field to set focus.
2. `type_text` one logical chunk — or prefer `set_value` for a whole field (below).
3. `zoom` the field region and read the pixels before pressing Enter. The accessibility tree
   can lag; `zoom` is the source of truth for short on-screen text.

## File dialogs: prefer `set_value` over typing

- `set_value <field-id> <value>` writes the whole string in one accessibility call — immune
  to focus loss and IME. For save/open dialogs, fill the **bare filename** when the dialog's
  location field already points at the right directory; some apps mangle typed absolute paths.
- After Save, expect a replace/overwrite sheet: `get_app_state query=replace` (or the localized
  替换/OK), click it, then confirm the file on disk.
- For a format selector: click the PopUpButton, `get_app_state query=<format>`, click the
  wanted item, and re-check the button value before saving.

## Stuck prompts and modals

- If an app sits at a "select object"-style prompt that ignores Escape: make it frontmost,
  click the input field, try Escape; if still stuck, press Enter — an empty selection often
  advances the loop. Do not queue more commands while a prompt is live; they are consumed.
- Hidden modal sheets swallow keystrokes aimed at the main window. If input goes nowhere,
  `get_app_state` without a window scope and look for extra windows (security prompts,
  replace sheets, file dialogs), then click through them.

## Input method (IME)

Chinese IMEs can swallow or remap typed characters. If typed text keeps vanishing despite a
correct focus, switch to the US keyboard layout (System Settings or `SetInput`) and verify
by typing 3 characters and `zoom`-ing the field. Re-check at the start of each working burst;
the user may switch it back between pauses.

## Clipboard fallback

`clipboard_write <text>` then `press_key cmd+v` is one atomic delivery of a whole string.
It overwrites the user's clipboard — say so. Paste still needs the `zoom` verification.

## Long-task discipline

- After each significant step, the artifact on disk is the record; name verification outputs
  per round. A probe log that stops after START without END means the script aborted.
- After an interruption, re-inspect the app state (windows, command line via `zoom`) before
  continuing; do not assume the pre-pause state.

## Safety

Read the target with `get_app_state` before destructive actions. Deleting files, sending
messages, or irreversible app actions still need the user's explicit confirmation even though
the plugin is enabled. Prefer the narrowest action that makes the step verifiable.
