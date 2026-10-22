# Industrial Agent Harness

<!-- impeccable:product-schema 1 -->

## Platform

web

The existing desktop product uses React in Electron. Desktop packaging and
interaction retain the host platform's native behavior. This repository delivers
only the desktop GUI; the standalone CLI, its SDK, and headless distribution
are retired by PD-096.

## Product Purpose

An engineering workbench for project-bound agent tasks, with a persistent chat,
scoped capabilities, approvals, and read-only project/artifact viewing. Product
truth and ownership follow AGENTS.md and IH-ARCH-001, not this design record.

## Capabilities and Constraints

- Project/chat navigation, agent conversation, and a collapsible file workspace.
- Settings at the lower left; workspace and file tree initially closed.
- Pinned Kimi kernel owns conversation context and execution lifecycle.
- Runtime, permissions, remote execution, and engineering verification keep
  their existing boundaries. UI presentation does not establish engineering facts.
- English and Chinese, light and dark themes. Current main fits the native
  window to the display with a 640 × 480 minimum, uses file/chat tabs below
  900 px, and a navigation drawer below 760 px; saved layout preference remains.

## Brand Commitments

- Industrial Harness name and the user-supplied green Core mark.
- On 2026-10-08 the user explicitly requested the neutral desktop style in their
  screenshot, with finer type and tighter line spacing. That reference replaces
  the former blue shell's visual authority, while preserving product functions.
- The user confirmed retaining the current theme preference.
- Message time and Copy appear on hover without clicking; keyboard access remains.

## Evidence on Hand

Repository product decisions, the supplied UI reference, retained original Core
mark and branding provenance, and native screenshot fixtures. Screenshots and
fixtures demonstrate UI behavior, never real model or engineering acceptance.

## Open Decisions

No additional audience, commercial, accessibility, or deployment claims were
provided for this visual change. This work records no global build-path preference.
