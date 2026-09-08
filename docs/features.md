# Feature status

[한국어](features.ko.md)

Validation applies to the stated implementation only. Passing tests does not mean a change was released.

| Feature | Implementation | Validation | Release |
| --- | --- | --- | --- |
| Persistent projects and project windows | [Project contract](spec/projects.md) implemented: unique directories, common and folder JSON settings, common-only opening mode, independent OS windows, saved layout and window geometry, and first-project startup | Both macOS hosts passed project checks, including concurrent duplicate opens, inheritance and reset, window isolation, and close/reopen restoration. Application quit saved pending changes; process restart opened the first saved project. Go 3/3 and Rust 3/3 storage tests passed | Unreleased |
| DOM layout | Outdated draw callbacks are ignored; display-resolution changes redraw the device-pixel grid | Library 310/310 passed; all 142 mutations caught after the resolution observation change | Unreleased |
| Native surface presentation | Per-window preparations share the UI thread's layer transaction. It waits for the main and visible application documents; external content renders independently. Project removal completes pending presentation before removing surfaces | `make examples-verify` passed 39/39 with no skips on macOS 26.6.2, including complete drag recordings, sidebar and rail alignment, and repeated main-layout changes within the external document's 700ms task interval | Unreleased |
| Native settings and menus | Shared CSS background and per-document blur; document-local effect sheets are excluded from copied modal styles | Both macOS hosts passed 12/12 modal checks, including clear dialog content and unchanged 50% shading after settings navigation. Manual appearance confirmed 2026-09-07 | Unreleased |
| Fractional surface rendering | macOS content webviews use device-pixel native coordinates while preserving CSS geometry. Native background recoloring removed. The DOM binding redraws when display resolution changes | Both macOS hosts passed fractional footer, resize, native pointer-coordinate, and 2×↔1× display-transition checks. Native height measured 293.5pt and document height 293.5 CSS px; the last device pixel received native input | Unreleased |
| Native window controls | Shared AppKit layout and geometry-only queries implemented | Maximization and recording-stop geometry checks passed in both macOS hosts | Unreleased |
| Windows and Linux native hosts | Wails additional-webview creation is not implemented; cross-platform CSS definition is shared | Wails Windows cross-compilation passed. Native execution on Windows and Linux is unverified | Unreleased |

Contracts: [projects and settings](spec/projects.md), [layout](spec/layout.md), [surface placement](spec/native-surfaces.md), [native modals](spec/native-modals.md). Procedures: [build and verify](operations/examples.md).

Project-window verification on 2026-09-08 rebuilt and restarted both macOS hosts before the 39-check suite. Storage tests and `make docs-check` passed. The library is unchanged by the project-window implementation. Its `make verify` result at `1a921b4` remains 310 tests passed and all 142 mutations detected, including build and comparison of generated artifacts with committed files.
