# Feature status

[한국어](features.ko.md)

Validation applies to the stated implementation only. Passing tests does not mean a change was released.

| Feature | Implementation | Validation | Release |
| --- | --- | --- | --- |
| Persistent projects and project windows | [Project contract](spec/projects.md) implemented: unique directories, common and folder JSON settings, common-only opening mode, independent OS windows, saved layout and window geometry | Both macOS hosts passed project checks, including concurrent duplicate opens, inheritance and reset, window isolation, and close/reopen restoration. Application quit saved pending changes; selecting a saved project after restart restored its workspace. Go 3/3 and Rust 3/3 storage tests passed | Unreleased |
| Project library | Startup and New Window display the library; creation/opening reuses an unassigned window. Includes workspace return, actual layout previews, search, filters, pins, folder selection, creation, Git clone, and Dock New Window | Both macOS hosts passed creation/open/clone window-reuse checks, failed directory operations, Dock actions, open status, pins, search, workspace return, and preview/workspace geometry equality. Process restart displayed saved projects without starting their surfaces | Unreleased |
| DOM layout | Outdated draw callbacks are ignored; display-resolution changes redraw the device-pixel grid | Library 310/310 passed; all 142 mutations caught after the resolution observation change | Unreleased |
| Native surface presentation | Per-window preparations share the UI thread's layer transaction. It waits for the main and visible application documents; external content renders independently. Project removal completes pending presentation before removing surfaces | Rebuilt macOS hosts passed complete drag recordings at backing-pixel resolution, sidebar and rail alignment, and repeated main-layout changes within the external document's 700ms task interval | Unreleased |
| Native settings and menus | Shared CSS background and per-document blur; document-local effect sheets are excluded from copied modal styles | Both macOS hosts passed 12/12 modal checks, including clear dialog content and unchanged 50% shading after settings navigation. Manual appearance confirmed 2026-09-07 | Unreleased |
| Fractional surface rendering | macOS content webviews use device-pixel native coordinates while preserving CSS geometry. Native background recoloring removed. The DOM binding redraws when display resolution changes | Both macOS hosts passed fractional footer, resize, and native pointer-coordinate checks with matching native/document half-point dimensions. Display-transition checks were skipped in the current run because only one 2× display was connected; the prior geometry implementation passed 2×↔1× transitions at `1a921b4` | Unreleased |
| Native window controls | Shared AppKit layout and geometry-only queries implemented | Maximization and recording-stop geometry checks passed in both macOS hosts | Unreleased |
| Windows and Linux native hosts | Wails additional-webview creation is not implemented; cross-platform CSS definition is shared | Wails Windows cross-compilation passed. Native execution on Windows and Linux is unverified | Unreleased |

Contracts: [projects and settings](spec/projects.md), [layout](spec/layout.md), [surface placement](spec/native-surfaces.md), [native modals](spec/native-modals.md). Procedures: [build and verify](operations/examples.md).

Project-library verification on 2026-09-08 rebuilt and restarted both macOS hosts. `node --test --test-concurrency=1 examples/test` passed 39 checks with 0 failures and 2 display-transition skips. Go 3/3 and Rust 3/3 storage tests, Wails Windows cross-compilation, and `make docs-check` passed. The layout library is unchanged. Its `make verify` result at `1a921b4` remains 310 tests passed and all 142 mutations detected, including build and comparison of generated artifacts with committed files.
