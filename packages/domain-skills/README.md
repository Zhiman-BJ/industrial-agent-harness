# Domain Pack consumer

This package loads fixed release metadata and resources from `@zhiman-bj/industrial-domain-packs`. The repository root and Desktop explicitly pin the same full commit URL in their manifests and pnpm lockfile. The loader declares the compatible package version as a peer; application roots supply the reviewed bytes. It validates declarations and installed archives and applies resource enablement policy. Domain capability/Skill/provider definitions and native implementations are maintained in the owner repository.

`src/consumer.cjs` binds maintained Skill resources to the generic Kimi integration. Only `project.work` is a Harness-owned Skill. `loadRegistry()` uses verified installed Packs when a Pack store is configured; development/test consumers use the pinned package or its bundled cache. Private PCB resources still require the registered external checkout and its complete source inventory. A public adapter is not permission to redistribute that private payload.

Harness packaging assembles unchanged release resources into portable caches/optional installable archives, records release content identity, and preserves licenses. These delivered copies are not editable maintenance sources. Adding a domain, capability, native action, Verifier, dependency recipe or domain Skill requires a Domain Packs release and a consumer pin update.

See [shared task and Pack migration](../../doc/shared-task-and-pack-consumption.md) for the exercised boundaries and qualification limits.
