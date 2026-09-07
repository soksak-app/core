# Feature status

[한국어](features.ko.md)

Validation applies to the stated implementation only. Passing tests does not mean a change was released.

| Feature | Implementation | Validation | Release |
| --- | --- | --- | --- |
| Layout draw preparation | Implemented; outdated draw callbacks are ignored | Library 309/309 passed; all 142 mutations caught after the draw revision change | Unreleased |
| Native surface presentation | Shared transaction waits for the main and visible application documents; external content renders independently; intersection shrinking removed | `make examples-verify` passed 29/29 on macOS 26.6.2; four additional alignment runs passed 16/16. The external-load check also verifies repeated main-layout changes within the 700ms task interval | Unreleased |
| Native settings and menus | Shared CSS background and per-document blur; settings and menus use distinct modes | Initialization-order tests and both hosts’ modal checks passed after replacing early function calls with state assignment. Manual appearance confirmed 2026-09-07 | Unreleased |
| Native window controls | Shared AppKit layout and geometry-only queries implemented | Maximization and recording-stop geometry checks passed in both macOS hosts | Unreleased |
| Windows and Linux native hosts | Wails additional-webview creation is not implemented; cross-platform CSS definition is shared | Native execution unverified | Unreleased |

Contracts: [layout](spec/layout.md), [surface placement](spec/native-surfaces.md), [native modals](spec/native-modals.md). Procedures: [build and verify](operations/examples.md).

Verification on 2026-09-08: `make verify` passed, including 309 library tests, all 142 mutations detected, documentation checks, build, and comparison of generated artifacts with committed files.
