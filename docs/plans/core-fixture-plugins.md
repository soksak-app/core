# Core fixture plugins

[한국어](core-fixture-plugins.ko.md)

Proposal for checklist item F25.2. It is pending the user's approval of its size; the approved content moves into the specifications and this file is then removed.

## Problem

A package's tests do not verify another package's implementation. Core's window checks break that rule: 42 of core's check files start from `fresh`, which opens `diagnostics.fixture` with a terminal tab and waits for the terminal plugin, and the compositor, presentation, placement, sidebar and settings checks measure the terminal plugin's native image region, the files plugin's sections and the browser plugin's document region. A change in those plugins can fail a core check, and a core check cannot run without them.

## Proposal

1. **Fixture plugins in core.** A folder `fixtures/plugins/` holds plugins that exist only for core's checks, each with `plugin.json`, a page and the smallest behaviour a core check measures:
   - `fixture-image`: a surface page with one image region whose raster the fixture sidecar supplies, a status with its session and cell size, and commands to resize and to fail a presentation on purpose;
   - `fixture-sections`: vertical and horizontal sections with controls and a status, for the sidebar, set and orientation checks;
   - `fixture-document`: a surface page with one document region, for the document region and modal checks.
2. **Fixture image sidecar in core.** `fixtures/sidecars/image` is a small Rust sidecar that implements the image supplier side of [native surfaces](../spec/native-surfaces.md#image-regions): it draws a solid raster of the requested size into an IOSurface, sends the image envelope, keeps each transfer image until the host answers it, and answers `closed` after it has released its session. It does not run a shell.
3. **Declarations, not names.** `scripts/workspace-registry.json` declares the fixture plugins and the fixture sidecar for `make registry` and `make install-plugins`; `diagnostics.fixture` takes its layout from a declared fixture instead of naming the terminal plugin.
4. **Checks.** `fresh` in `e2e/fixture.mjs` waits for the fixture image surface; each of the 42 check files changes from terminal, files and browser statuses and commands to the fixture ones. Checks of terminal, browser and files behaviour move to their repositories in F25.3 to F25.5.

## Cost

Measured on 2026-10-05: of the 42 core check files, only `project-directory`, `library`, `projects` and `text-size` use terminal statuses or commands themselves; the others depend on the terminal plugin only because `fresh` waits for a terminal surface, so `fresh` and those four files change. The terminal service's IOSurface frame code is 1,301 lines; the fixture sidecar draws one solid raster and answers its envelopes, a few hundred lines. The work is about one to two days, and the window suites must pass on both hosts before and after each step.

## Order

F25.2 follows the release (R2) only if the user decides so; otherwise it starts with the fixture sidecar and its contract tests, then the fixture plugins, then the checks one file group at a time.
