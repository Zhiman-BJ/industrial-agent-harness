---
name: "Industrial Harness desktop"
description: "A neutral desktop conversation workbench with compact system type and a persistent project context."
colors:
  light-bg: "#fafafa"
  light-panel: "#f2f2f2"
  light-raised: "#ffffff"
  light-border: "#dedede"
  light-control-border: "#b5b5b5"
  light-text: "#252525"
  light-muted: "#686868"
  light-hover: "#e8e8e8"
  light-active: "#e9e9e9"
  light-accent: "#343434"
  light-code: "#f3f3f3"
  light-sidebar: "#eeeeee"
  light-sidebar-hover: "#e3e3e3"
  light-sidebar-active: "#dedede"
  light-success: "#317357"
  light-danger: "#b13939"
  light-warning: "#96631e"
  dark-bg: "#161616"
  dark-panel: "#222222"
  dark-raised: "#282828"
  dark-border: "#3a3a3a"
  dark-control-border: "#707070"
  dark-text: "#dedede"
  dark-muted: "#a1a1a1"
  dark-hover: "#343434"
  dark-active: "#333333"
  dark-accent: "#dedede"
  dark-code: "#202020"
  dark-sidebar: "#282828"
  dark-sidebar-hover: "#343434"
  dark-sidebar-active: "#3d3d3d"
  dark-success: "#85d0ae"
  dark-danger: "#f19b9b"
  dark-warning: "#edc580"
typography:
  welcome:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'IBM Plex Sans', sans-serif"
    fontSize: "26px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  project-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'IBM Plex Sans', sans-serif"
    fontSize: "30px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "-0.03em"
  dialog-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'IBM Plex Sans', sans-serif"
    fontSize: "20px"
    fontWeight: 500
    lineHeight: 1.5
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'IBM Plex Sans', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  conversation:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'IBM Plex Sans', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'IBM Plex Sans', sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  metadata:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'IBM Plex Sans', sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
  domain-status:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'IBM Plex Sans', sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "16px"
  source:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  inline-code: "4px"
  control: "6px"
  approval: "7px"
  secondary: "8px"
  send: "9px"
  tab: "9px"
  popover: "12px"
  composer-body: "13px"
  surface: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  inset: "14px"
  lg: "16px"
  xl: "20px"
  section: "24px"
  canvas: "32px"
components:
  button-primary:
    backgroundColor: "{colors.light-accent}"
    textColor: "{colors.light-bg}"
    rounded: "{rounded.control}"
    typography: "{typography.label}"
    padding: "10px 14px"
  button-primary-dark:
    backgroundColor: "{colors.dark-accent}"
    textColor: "{colors.dark-bg}"
    rounded: "{rounded.control}"
    typography: "{typography.label}"
    padding: "10px 14px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.light-muted}"
    rounded: "{rounded.secondary}"
    typography: "{typography.label}"
    padding: "5px 10px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.light-muted}"
    rounded: "{rounded.control}"
    padding: "7px"
    size: "32px"
  button-send:
    backgroundColor: "{colors.light-accent}"
    textColor: "{colors.light-bg}"
    rounded: "{rounded.send}"
    padding: "7px"
    size: "34px"
  composer:
    backgroundColor: "{colors.light-panel}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.surface}"
    typography: "{typography.conversation}"
    padding: "0"
  composer-body:
    backgroundColor: "{colors.light-raised}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.composer-body}"
    typography: "{typography.conversation}"
    padding: "14px"
  navigation-chat-active:
    backgroundColor: "{colors.light-sidebar-active}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.control}"
    typography: "{typography.label}"
    padding: "7px 10px"
  workspace-tab-active:
    backgroundColor: "{colors.light-raised}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.tab}"
    padding: "9px 12px"
  domain-pill:
    backgroundColor: "{colors.light-raised}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.pill}"
    typography: "{typography.domain-status}"
    padding: "5px 9px"
  approval:
    backgroundColor: "transparent"
    textColor: "{colors.light-text}"
    rounded: "{rounded.approval}"
    padding: "12px"
  user-message:
    backgroundColor: "{colors.light-active}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.surface}"
    typography: "{typography.conversation}"
    padding: "10px 14px"
  message-copy:
    backgroundColor: "{colors.light-panel}"
    textColor: "{colors.light-muted}"
    rounded: "{rounded.popover}"
    padding: "0"
    size: "32px"
---

# Design System: Industrial Harness desktop

## Chat execution status

The execution card extends the neutral workbench using Impeccable's Operate and
polish guidance. Task and remote state stay together; conversation remains the
primary work area.

- The collapsed control reserves a row below the header, with a 32 px minimum
  target, a single-line status and a tabular task count.
- At a chat-column width of 960 px or more, opening the card reserves a 320 px
  conversation/composer gutter for a 296 px side panel. This responds to the
  actual chat column, including split workspace layouts.
- In narrower columns the card stays in flow above messages, bounded to
  36 vh / 320 px. Content scrolls independently; the header remains available.
- Use a raised surface, one border and a 12 px radius. Headers have a 16 px icon
  column, 8 px gaps and 16 px insets. State text gets its own line; chevrons share
  a column. Task text aligns with section text; the active row uses panel fill.
- Progress reflects completed/total tasks. Pending work never reads complete;
  unfinished recorded work does not imply an actively running agent. Remote
  failure/unknown states override healthy presentation. Ready requires the
  existing domain qualification and file-sync prerequisites.
- Sections remain mutually exclusive. Escape collapses and restores trigger
  focus. A concise live region announces state, not the interactive card.
  Reduced motion disables spinner/chevron motion.
- Project/capability pages hide presentation while keeping polling mounted.
  Both themes use existing semantic tokens and retain user preference.

`chat-status.test.cjs` covers task states, remote failures, prerequisites and
translations. `remote-ui-selftest` includes bounds, focus and capture checks at
1440, 1000 and 640 px. Native checks require Electron and a local mock gateway;
adding coverage alone is not evidence that it ran.

## Overview

**Creative North Star: "Neutral desktop conversation workbench"**

The user's desktop reference replaces the former blue shell. Charcoal content, slightly lighter navigation and input surfaces, fine system type, and quiet gray selection keep attention on the current project and conversation. Light mode uses the same hierarchy in neutral whites. The user's saved theme preference continues to determine the active theme.

This records the implemented shell in [style.css](src/style.css), [App.tsx](src/App.tsx), and [MessageActions.tsx](src/components/MessageActions.tsx), under the approved [surface direction](.impeccable/surfaces/apps-desktop-src-app-tsx.md). [PRODUCT.md](../../PRODUCT.md) supplies the retained green Core identity and functional constraints. Pack-supplied domain markers remain functional metadata.

**Key Characteristics:**

- Neutral paired themes with tonal panel separation.
- Regular system type, compact conversation rhythm, and restrained medium headings.
- Thin Lucide controls and quiet gray navigation selection.
- One composer centered on arrival and anchored below an ongoing conversation.
- Hover and keyboard message controls with reserved space.

## Colors

The frontmatter mirrors the actual `--ia-*` semantic colors; its `light-` and `dark-` prefixes identify the two implemented theme values.

### Primary

The neutral accent controls filled primary actions, Send, caret, and keyboard focus. It reverses against the conversation background in dark mode. The green Core mark is a retained raster identity asset, not a new control color; use its existing [runtime assets](public/README.md) and [provenance](branding/README.md).

### Neutral

Conversation background, panel, raised surface, and sidebar form the ground. Text and muted text supply hierarchy; border separates surfaces, while control-border supplies stronger form and scrollbar definition. Hover, active, sidebar-hover, and sidebar-active distinguish interaction and selection. Code uses its own quiet surface. Success, danger, and warning are semantic state colors; they do not color the general shell.

**The Paired Theme Rule.** Resolve foreground, surface, and selection from the same active theme. Preserve the saved theme preference.

## Typography

**Body Font:** the platform system UI stack in the frontmatter.
**Label/Mono Font:** labels share the system stack; source previews use the recorded monospace stack. IBM Plex Sans remains a bundled, licensed Latin fallback; it follows platform families in the actual CSS rather than serving as the primary macOS face.

**Character:** Fine, regular text and modest medium headings match the desktop reference. There is no separate display face. Tabular numerals support times and numeric readouts.

### Hierarchy

- **Welcome:** the recorded welcome role; below a 440 px chat container its size becomes 22 px. Empty sessions also use 22 px when content height is 600 px or less.
- **Project / dialog titles:** the separate recorded roles, used on project details and model dialogs.
- **Conversation:** user messages, assistant prose, and composer input use the conversation role.
- **Labels / metadata:** navigation and message time use label; status hints use metadata and domain pills use domain-status. Compact settings and diagnostics retain smaller 10 px text.
- **Markdown headings:** 20 / 17 / 15 / 13 px, medium weight (500), with line height (1.4). Heading margins are 1.1em above and 0.45em below; paragraphs use 0.6em vertical margins.
- **Source:** the recorded source role. Tool output and Markdown code remain monospace.

**The Quiet Hierarchy Rule.** Use regular weight (400) for conversation and chat labels, and medium weight (500) for established headings and project names.

## Layout

The shell retains project/chat navigation, conversation, and an optional file workspace in either split or tab layout. Settings stays at the lower left. Workspace and file tree start closed; both outer panels remain collapsible. The chat surface has a thin border and rounded outer edge inside a 6 px shell inset. Only split layout with an open workspace squares the chat's adjoining right edge.

The sidebar is 256 px wide, becoming 220 px at 1250 px viewport width and 204 px at 1050 px. Below 760 px content width, it becomes a 248 px overlay drawer opened from the sidebar control; its backdrop dismisses it. Shared headers are 48 px, while the workbench tab bar has a 52 px minimum. Conversation and composer use a 680 px target measure with at least 24 px horizontal padding; compact viewports use 20 px, and below 760 px conversation padding becomes 16 px while the composer wrap uses 12 px. The empty title, introduction, and composer form a centered group, with existing project/file actions below. After a turn exists, the scrolling conversation grows and the composer sits at the bottom.

In split layout the workspace defaults to 48% of available width, with a 360 px minimum; at 1250 px its minimum is 340 px, and at 1050 px its default basis is 45%. Its file tree steps from 176 to 148 to 136 px. User-resized workspace width is retained. Workspace controls can wrap, and project paths truncate or wrap in their established contexts.

Below 900 px content width, the shell automatically uses chat/file tabs and disables the switch to split layout. At wider widths, it restores the user's saved layout choice. Automatic adaptation does not overwrite that preference. The selected chat or file occupies the full workbench width; hidden chat and Viewer surfaces stay mounted. File tabs also remain available inside the split workspace. Tabs and Viewer sessions last for the current window, while layout preference is saved locally.

Below a 560 px chat container, hide the visual keyboard hint while retaining the accessible input description. Below 440 px, reduce the composer body inset to 12 px and the empty-state action margin above to 12 px. The renderer has no fixed minimum-width floor.

At content heights of 600 px or less, empty chat uses a compact vertical arrangement: the welcome scroll region does not shrink and has 12 px top padding; the title becomes 22 px with an 8 px bottom margin; composer top padding and body inset become 12 px; textarea height becomes 50 px; and the welcome actions use 12 px top margin. Hide the visual keyboard shortcut hint in this state while preserving the accessible help. This adapts the existing centered arrival group to short windows.

Native window sizing uses logical pixels and the display's available work area. The minimum is 640 × 480, clamped to that area on smaller displays. First launch centers a window no larger than 1440 × 900; later display changes keep it within visible bounds. The former 1000 × 650 minimum is now a verification size, not the native minimum. The implementation is recorded in [window-bounds.cjs](electron/window-bounds.cjs).

Current inspected native captures are macOS arm64 in both themes, Chinese/English, and empty/chat/workspace states, including file tabs, Markdown, and compact tabs. Captures establish visual observations; they do not assert that the in-progress native regression matrix has passed or establish engineering acceptance. See [responsive layout behavior and verification scope](../../doc/desktop-layouts.md), [UI verification](../../doc/desktop-ui-refinement.md), [CI coverage](../../doc/ci-regression.md), and [Desktop preview limits](README.md) for broader platform and packaged-runtime limits.

## Elevation & Depth

The resting shell, composer, and selected workspace tabs are flat. Tone, thin rules, and selected fills provide separation. Overlays use diffuse shadows: Settings (`0 12px 32px #00000026`), model dialogs (`0 16px 56px #00000033`), agent logs (`0 20px 70px #0005`), and the compact navigation drawer (`4px 0 24px #00000030`). Its full-area backdrop uses the same neutral translucent black (`#00000030`). The sidecar records these extensions.

**The Flat Shell Rule.** Keep ordinary navigation, messages, and the composer free of added shadows; use the existing overlay shadows for floating surfaces.

## Shapes

Small controls use the control radius; message bubbles, composer, chat frame, and major dialogs use the surface radius. The composer body has its own inset corner. Domain pills are fully rounded. Thin borders and flexible rectangular panels define the workbench; there are no decorative icon tiles.

Lucide shell icons inherit a thin stroke (1.6). Most control icons are 13–18 px inside 32 px targets; Send is 34 px. The sidebar Core mark is 22 px. Domain markers retain their Pack-supplied meaning rather than becoming shell decoration.

## Components

### Buttons

Primary project actions use neutral accent against the background. Send uses an upward Lucide arrow and its dedicated shape; hover lowers opacity to 0.82. Other primary project actions lower opacity to 0.85. Empty-state secondary actions use transparent fill, a thin border, and muted labels. Ghost controls gain the hover surface. Disabled shell buttons use opacity (0.42).

Keyboard focus uses a 2 px accent outline; inputs and summaries offset it by 3 px, while buttons and selects use 2 px. Button state changes are immediate, preventing mixed colors during theme switches.

Capability navigation uses a fixed 16 px icon column and a left-aligned label
column. Its header and body fill the workbench; switching sections or language
does not recenter the navigation. The selected row keeps the sidebar's quiet active fill and medium label;
keyboard focus uses the same 2 px outline inset into the row, without enlarging
its outer shape. At the compact breakpoint, each icon retains a 32 px target,
accessible name and tooltip when the visual label is hidden.

### Domain installation

The first-run domain selector shares the model dialog's neutral surface, 14 px radius,
shadow, inset and ruled header/footer. Its task title is a compact 16 px medium label;
body and metadata use the existing 12 px and 11 px roles. The close control is a 32 px
Lucide ghost button. Initial focus lands on the title, with normal keyboard focus
rings preserved on controls.

Use flat selection rows with a quiet selected fill, not bordered cards. Keep version
and download size beside the domain name, with declared prerequisites below. Show
installed footprint, working-space estimate and available disk space once in the
selection summary. Estimates warn; the runtime's verified precheck decides whether
installation can proceed. Progress and completion use ordinary ruled sections, and
Capability Center uses the same flat rows without decorative icon tiles.

The body scrolls independently from the fixed dialog actions, including at 640 × 480.
Shared neutral tokens drive light/dark themes; semantic readiness colors keep their
existing meaning. Preserve multi-selection, accurate catalog states, cancellation,
retry, update, repair and next-step actions while changing presentation. The visible
word “installed” must remain distinct from verified executable readiness.

### Platform account

The account dialog follows the compact installation-dialog rhythm: a 16 px medium
title, 22 px horizontal inset, 32 px close target, and the shared neutral raised
surface. Account name and issuer form one compact identity block beside the actual
sign-in status; green is reserved for the signed-in state. Credential-storage
information is secondary text, and the local-use hint appears while signed out.

Connection fields stay under a disclosure, initially open when setup is required.
The body scrolls independently while the header and right-aligned login, cancel,
or logout action remain visible. Browser sign-in and code submission use the
neutral primary button; connection saving and browser reopening use secondary
buttons. Inputs, warnings, focus rings, and checkboxes resolve from the active
theme. The account selftest includes both themes and 640 × 480 layout checks;
these checks require a working native Electron session to establish visual evidence.

### Inputs / Fields

The composer uses panel tone around a raised body, with a thin border. Empty sessions include a project strip above that body. Input starts at 64 px high, or 50 px in short empty sessions, resizes between 50 and 160 px, and uses the conversation role. Focus-within adds an accent border and 1 px outline offset by 3 px. Border motion is 160 ms with `cubic-bezier(0.16, 1, 0.3, 1)`; reduced motion disables it.

Preserve Enter to send, Shift+Enter for a line, IME composition handling, and the accessible help text. Availability follows actual project/domain, task, image-input, and remote readiness. The approval selector stays explicit.

### Navigation

Project names sit above read-only domain metadata. The active project uses sidebar-hover tone; the current chat uses sidebar-active tone. Other chat rows remain quiet at regular weight. Nested chats retain a fine vertical rule. Deletion controls appear on row hover or keyboard focus. Names truncate without pushing out controls, and the sidebar brand may wrap at compact widths.

### Workspace tabs

The workbench keeps one chat tab beside file tabs; split layout uses the same file tabs in its workspace. Tab groups use panel tone, a thin bottom rule, and 4 px gaps. The selected tab uses raised tone, medium weight (500), and no shadow. Tab corners are 9 px; labels use 9 px by 12 px padding and truncate within a 280 px cap, reduced to 220 px below 760 px. Overflow scrolls horizontally.

A single-click file preview uses an italic title. Double-click or the Pin control keeps it; the Plus control opens current-project files. Close controls affect the file view only. Preserve tab roles, selected state, keyboard arrows/Home/End/Delete, and focus restoration. Chat status represents actual running, approval, or question state. Layout changes retain the mounted conversation, draft, and Viewer state; they do not change task or permission behavior.

### Chips / Containers

The domain pill is read-only status, with a thin border, raised fill, and Pack marker or Lucide fallback. Domain selection occurs in its existing creation or project-detail controls. Approvals and questions use compact bordered containers with a 12 px inset; required actions stay visible. Thinking and tool entries retain their existing collapsed presentation and explicit states.

### Messages and Copy

User bubbles align right; assistant replies sit directly on the conversation ground. Each message reserves a 32 px metadata row with 2 px top margin, so revealing time and Copy does not move content. Hover and focus-within reveal it; devices without hover keep it visible. Copy has an accessible name, a temporary success check, a live status announcement, and localized error text.

Time is 24-hour local display with a full date/time tooltip when a valid recorded time exists; old replies without recorded time omit it. Copy retains the selected message body, preserving assistant Markdown while excluding leading thinking, tool output, and UI labels. These are display controls, not verification facts.

## Do's and Don'ts

### Do:

- **Do** resolve colors through the active shell theme and preserve the saved preference.
- **Do** keep conversation and input at 13 px / 1.6, with regular weight.
- **Do** retain the green Core raster and functional Pack domain markers.
- **Do** keep time and Copy available on hover, keyboard focus, and non-hover devices without layout movement.
- **Do** preserve actual task, remote, approval, and read-only Viewer boundaries.

### Don't:

- **Don't** restore the discarded blue shell or a coarse, heavy conversation hierarchy.
- **Don't** add shadows or decorative icon tiles to resting shell surfaces.
- **Don't** make domain status in the generic composer an editable selector.
- **Don't** infer readiness, approval, timestamps, or engineering acceptance from visual presentation.

The existing uppercase navigation section labels, specialized Viewer controls, and log-specific styles are not new general typography or icon rules. This record leaves their implementation in place and does not promote them as patterns for new shell surfaces.
