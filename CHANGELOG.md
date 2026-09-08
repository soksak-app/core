# Changelog

[한국어](CHANGELOG.ko.md)

## Unreleased

- Add the private native API inventory with a necessity review, exact callers, framework dependencies, and update verification steps. Require it as the first document reviewed after native update failures. Correct the input-monitor comment about mouse-exit delivery. Runtime behavior is unchanged; `make docs-check` passed.

- Window checks wait for the initial terminal document, its theme, and native presentation before recording.

- Render macOS content webviews in device-pixel native coordinates while preserving CSS dimensions and device-pixel ratio. Native surface and document sizes now match at half-point heights. Remove native backing-background recoloring.
- Redraw the DOM layout when display resolution changes, including when its CSS size remains unchanged. Remove the resolution listener when the view is destroyed.
- Verify fractional footer pixels throughout a complete divider drag, document geometry after resizing and display-scale transitions, and native pointer coordinates in the final device pixel. Both macOS hosts passed these checks in `make examples-verify` (35/35).

- Exclude document-local adopted stylesheets when copying modal CSS. Settings navigation previously copied the main document's blur into the dialog. Both macOS hosts passed 12/12 modal checks with the new navigation assertions.
- Render settings and add/split pickers in webviews inside the main window. Settings uses a full-viewport 50% black CSS backdrop and 3px blur in each background document; menus retain transparent backgrounds without blur.
- Preserve modal ordering after surface replacement, move the settings card within its webview, resize it with the parent, and remove the modal and blur on main-document reload. Settings closes only with ×.
- Apply complete native surface rectangles and card DOM in one layer transaction after the main and visible application documents confirm presentation. External documents retain independent content rendering. Remove intersection shrinking and transparent rendering from ordinary surfaces. Hide surfaces whose next slot cannot be measured before changing the DOM.
- Ignore outdated DOM draw callbacks when a later layout preparation exists. Return the compositor's preparation promise to its caller.
- Maintain native button centering when AppKit reparents buttons during recording. Position queries no longer change layout.
- Record through the final visible return position of a driven gesture. Require complete round trips, zero measured overflow, and consistent terminal foreground, card, sidebar, and rail geometry. Verify repeated main-layout changes during the external document's 700ms task.
- Preserve background state delivered before the background script initializes.
- Remove the native visual-effect backdrop and the delayed-cursor diagnostic. The retained overlapping-webview input check tests pointer and keyboard routing.
- Subscribe to terminal output before starting the shell. This is a separate terminal startup correction.
- Separate specifications, operating procedures, feature status, and this change record. Add paired documentation and `make docs-check` to the required checks.

The main-only presentation check allowed a Tauri view to commit at 562pt while its document clipping layer remained 558pt. Shared presentation now includes visible application documents. After this correction, `make examples-verify` passed 29/29 on macOS 26.6.2, including background initialization, modal behavior, window controls, alignment, and main-layout progress during external work. Four additional alignment runs passed 16/16. The earlier Wails background initialization failure is fixed. Manual settings blur was confirmed in both hosts on 2026-09-07. Windows and Linux execution is unverified. These changes have not been released.

Library validation on 2026-09-08: `make verify` passed, including 310/310 tests, all 142 mutations detected, documentation checks, build, and comparison of generated artifacts with committed files.
