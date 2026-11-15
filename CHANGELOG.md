# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- A complete Chinese usage guide with real UI screenshots: `docs/USAGE.md`.
- Daily plugin marketplace discovery with optional categories; the default category is full-stack development. Memory fusion adapters remain fixed and are not market-probed.
- The Fusion tab shows installed full-stack plugins from the active profile in a separate read-only section.

### Fixed
- Fusion file probes keep the session workspace when `storageRoot` points at a custom directory. Add regression coverage for storage resolution and Fusion detection.
- Fusion tool probes now recognize the real `mem_search` / `mem_pack` tools of `dsh-memory-xfy`, and the unique `memory_*` tools of `dsh-task-memory`.
- Fusion reports a compatible package installed in the active profile as available even before data/tools are found; the summary shows available and enabled counts, and uninstalled targets cannot be newly enabled.
- File-bridge compatibility targets ship built-in adapters, so all five targets remain usable without an external package; data is still only imported when matching files exist.
- Fusion targets are now presented as built-in adapters. The external `dsh-memory-xfy` demo bundle was removed so its broken sidebar panel no longer loads; the built-in xfy adapter remains available.
- Adapter cards no longer print missing `.dsh-memory/**` path diagnostics.

### Changed
- Deduplicated screenshots and aligned README, USAGE, and DESIGN with the fixed built-in memory adapters and the installed full-stack plugin section.

### Planned
- Task-network update tool (`memweave_network_update`).
- `superseded` workflow and merge suggestions.
- Vector retrieval with explainable ordering.
- More discovery categories and marketplace reports.

## [1.0.0] - 2026-11-15

### Added
- **Ten model tools**: `memweave_decompose`, `memweave_precipitate`, `memweave_memory_find`, `memweave_memory_verify`, `memweave_memory_list`, `memweave_loop_start`, `memweave_loop_record`, `memweave_fusion_status`, `memweave_import`, `memweave_export`.
- **Verifiable memory lifecycle**: `candidate → verified / disputed / superseded`, confidence updates, verification log, superseded archive.
- **Forced anti-pattern recall**: relevant anti-patterns are never buried outside the top results.
- **Measurable Loops**: mandatory metric name/target/unit/cadence; trends from round three.
- **Deterministic task networks**: six-node scaffold with `dependsOn` and `human/agent/hybrid` executors.
- **Three settings tabs**: `存储与分类`, `技能浏览`, `融合`.
- **Same-origin Host API**: `/memweave/api` for snapshot, memories, detail, verify, storage and fusion writes, with loopback/origin trust fence.
- **Atomic local storage**: exclusive `wx` temp file plus `rename`, orphan `.tmp.*` cleanup.
- **Read-only fusion layer**: file/service/tool-name probes for five compatible memory plugins; explicit import/export only.
- **Optional additive aggregate**: declarative manifest plus `scripts/prepare-aggregate.mjs`; never duplicates the `dsh-memweave` Loader row.
- **35 tests** covering Host tools, API, path handling, client registration, and aggregate generation.
- **Documentation**: Chinese and English README, full design document, original SVG icon, locale metadata.

### Notes
- DSH 0.2.x has no `ctx.settings.register`; the plugin uses `Config` + `configEditor` and the same-origin API instead.
- DSH Loader patches have no `optional: true` row semantics; the aggregate is an additive, generated package.
- Ordinary Config edits restart the plugin by DSH lifecycle rules.

[Unreleased]: https://github.com/lw24-1936/dsh-memweave/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/lw24-1936/dsh-memweave/tree/v1.0.0
