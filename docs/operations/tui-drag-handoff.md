# TUI terminal drag investigation handoff

## Snapshot

- Date: 2026-09-28 (Asia/Seoul).
- Repository: `~/polyspec/soksak`.
- Branch: `fix/tui-repeat-drag`.
- Current HEAD: `3b5fc1b0 test: reproduce TUI drag selection loss`.
- The working tree has uncommitted changes for the completed `.3.2.1` child-receipt instrumentation: the real-window test, its measurement helper and tests, the vt-core `pty.pending` measurement and its sidecar tests, the terminal plugin's diagnostic command with its tests, the runtime spec, the canonical feature checklist, both changelogs, and this paired handoff document. Do not discard or commit these changes without first reviewing them.
- The task is still active: `V5-96-14-6-8-2-1`, with `.3.2.1` (sidecar-owned PTY child-receipt instrumentation) complete and `.3.2` (find the first divergence after host PTY writes) continuing. No product correction has been identified or made. Neither host has passed the required 60-cycle acceptance.

## User-visible failure and acceptance contract

The report concerns actual TUI text selection with an ordinary mouse drag. Shift-drag is not the requested behavior. The failure is intermittent and depends on the preceding interaction: a drag may work, a click at a third point in the TUI may be followed by a failed drag, and clicking another card then returning may restore selection temporarily. The implementation must make ordinary dragging repeatable on both Tauri and Wails.

The canonical checklist requires, per host, one continuing TUI session and 60 uninterrupted cycles: third point in the prompt, same transcript row, or blank TUI area; normal or slow drag; ten repetitions for each combination. Each cycle contains an initial drag, the third-point click, and a directly measured retry. A failed direct retry remains a failure even if a later recovery succeeds. A result must be tied to fresh native input, matching DOM and PTY identities, the terminal's selected cells, and the full requested-rate visual recording. Missing input, frames, statuses, or trace capacity fails the run. The test must also retain Shift as a separate control.

## What has been established

1. The acceptance checker had real holes. It could allow an old mouse-up to satisfy a new attempt and could replace a failed retry with a later recovery result. The owning fixtures were run Red against those cases and now pass Green after the checker correction. The focused checker currently passes 9/9.
2. The tracked real-TUI test records actual native pointer gestures, complete captures, DOM down/move/up and capture events, correlated terminal pointer writes/replies, terminal selection state, and pixels in the six `header` cells. It removes raw recordings after extracting evidence; per-host JSON evidence remains in the system temporary directory.
3. On rebuilt Tauri and Wails with TUI, an initial drag has selected all six cells. Failed gestures have also shown the expected eight SGR reports and a complete DOM pointer sequence. The same SGR byte sequence is present in successful and failed gestures within each host.
4. Failures are intermittent and not limited to the third-point click. The recorded Tauri diagnostic had direct retries fail in 3/3 cycles, later first gestures fail in cycles 2 and 3, and all three recovery gestures select zero cells. Wails produced different outcomes across two short diagnostics: one run passed cycles 1 and 3 but failed the initial and direct gesture in cycle 2; a later run failed all three cycles, while one recovery selected all six cells and two selected none. This variability is itself evidence; neither run is an acceptance pass.
5. Focus is a measured, independent intermittent factor, but it does not explain the selection loss by itself. Wails showed both a successful and failed recovery with the target native responder. Tauri showed a recovery interval where the WebView retained first-responder ownership for 20 seconds. Do not infer that setting focus alone fixes this issue.
6. The direct-retry visual check was strengthened to reject stale selection and wait up to 1000 ms for a new terminal selection. The capture therefore continues to about 1.13 seconds after mouse-up. In the most recent short diagnostics, failed direct attempts remained at zero selected cells and the terminal status wait timed out. The focused checker Red was 7/9 before the new timeout/stale-selection assertions were implemented, and Green is 9/9 afterward.
7. macOS `dtruss` could not attach because System Integrity Protection is enabled and tracing requires additional privileges in this environment. This only rules out that observation method here; it does not explain the product defect.
8. Child input receipt is now measured by sidecar-owned instrumentation (`.3.2.1` complete). vt-core answers a `pty.pending` operation for the open session with the FIONREAD count of master-written bytes the child has not yet read; on macOS the master and slave share one tty, so the master fd reads that shared input queue. TIOCOUTQ was rejected by measurement because it reads the child's output queue. Owning fixtures prove the pending count for a non-reading raw child, the drain for a reading child, and exact child receipt through the production write path (sidecar suite 172/172). Error replies, including a missing session, carry the same `pty.pending` event marker, and diagnostic builds expose the `terminal.pty.pending` command with single-request correlation and a five-second bound (plugin suite 115/115). The never-run host-side Perl receiver was removed. A canonical-mode line that has not been assembled is not counted, so a raw-mode child is the measured contract, and a drained queue proves delivery to the child, not interpretation by the program.

## Child-receipt instrumentation state

The Perl receiver described in the previous handoff was discarded before it ever ran; do not restore it. Its replacement is implemented, tested, and documented:

- `sidecars/vt-core` answers `{operation: "pty.pending"}` for the open session with `{event: "pty.pending", pending}` from the platform PTY input queue (`sidecars/vt-core/src/platform/pty.rs`), and every error reply, including a missing session, carries the same event marker so the reply identifies its request (`src/protocol.rs`, `tests/serve_contract.rs`).
- Owning fixtures cover a non-reading raw child, a draining child, and the production write path (`tests/pty_lifecycle.rs`).
- Diagnostic builds expose `terminal.pty.pending` through `plugins/terminal/diagnostics.json`, `ui/terminal-diagnostics.js`, and the single-slot resolver in `ui/terminal.js`; the command resolves to `{pending}` and rejects explicit sidecar errors (`test/terminal.test.mjs`, `test/manifest.test.mjs`).
- `e2e/real/tui-drag.test.mjs` records, per gesture, two `terminal.pty.pending` samples — immediately after the gesture and after the bounded selection settle wait — plus any `ptyPendingError`, instead of the removed probe. The kernel queue has no notification, so sampling at those instants is the only observation; an earlier 25 ms poll was removed because the e2e source audit rejects fixed-sleep polling, and every gesture (initial, direct, recovery) now uses the selection settle wait, which bounds the second sample.
- The contract is specified in `docs/spec/terminal-runtime.md` (paired `.ko.md`).

What remains under `.3.2` is the measurement itself: rebuild both hosts, run the short diagnostics, and read the recorded `ptyPending` samples against the correlated pointer traces to locate the first divergence after host PTY writes.

## Current files and evidence

- `e2e/real/tui-drag.test.mjs`: real TUI setup, diagnostic 3-point cycles, actual pointer input, capture, separate initial/direct/recovery records, and the two per-gesture PTY pending samples.
- `e2e/tui-drag-measurement.mjs`: strict gesture result assertions, including fresh selection and post-release selection wait.
- `e2e/test/tui-drag-measurement.test.mjs`: unit fixtures for false acceptance and the new selection-wait rules.
- `sidecars/vt-core`: the `pty.pending` measurement, protocol error marker, and owning lifecycle/serve-contract tests.
- `plugins/terminal`: the `terminal.pty.pending` diagnostic declaration, module wiring, and plugin tests.
- `docs/features.md` and `docs/features.ko.md`: the single source-of-truth checklist. `.3.2.1` is complete; continue under `.3.2` and do not reopen completed items.
- `CHANGELOG.md` and `CHANGELOG.ko.md`: current evidence records so far; update the pair when the next verified result is available.
- Latest prior JSON snapshots: `${TMPDIR}/soksak-tui-drag-tauriv2.json` and `${TMPDIR}/soksak-tui-drag-wailsv3.json` (the actual system temp directory resolves under `/var/folders/.../T`). They predate the pending-drain recording and contain no `ptyPending` samples. Captured video frames were removed after measurement.
- `docs/operations/tui-drag-handoff.md` and `.ko.md`: this transfer document. Keep its paired versions aligned as the investigation advances.

The last observed process listing contained one Tauri process using `/tmp/soksak-check-tui-repeat-tauriv2` and one Wails process using the user's normal configuration directory. Recheck before any action; never infer that a recorded PID or endpoint is still current. At the end of a test session, leave one Tauri and one Wails user-path app open, and remove disposable instances through the declared graceful shutdown path.

## Resume procedure

1. Read this handoff, `AGENTS.md`, `docs/features.md` at `V5-96-14-6-8-2-1`, and the current diff. Check `git status`, current branch/HEAD, `pgrep -alf 'soksak-(tauriv2|wailsv3)'`, each endpoint's PID/executable/config directory, and executable hashes. Do not assume a previous process is running the current bundle.
2. If the `.3.2.1` changes are still uncommitted, run the gates first — `make docs-check`, `pnpm test`, `make boundaries`, `make exposure-check`, `pnpm -F @soksak/e2e test`, and `make native-test` for the Rust changes — and then commit the explicit paths as one unit (sidecar, plugin, e2e, spec, features, changelogs, this document). Do not use `git add -A`.
3. Run the focused unit tests:

   ```sh
   node --test e2e/test/tui-drag-measurement.test.mjs
   ```

4. Build both diagnostic bundles from this checkout:

   ```sh
   make -B tauriv2-build wailsv3-build
   ```

5. Run a short diagnostic on each host before any 60-cycle attempt. A diagnostic run intentionally exits nonzero if a cycle fails; retain that Red and inspect its full JSON and recording-derived measurements. Example for Tauri:

   ```sh
   SOKSAK_APP=tauriv2 \
   SOKSAK_CONFIG_DIR=/tmp/soksak-check-tui-repeat-tauriv2 \
   SOKSAK_TUI_DRAG_DIAGNOSTIC=1 \
   node --test --test-concurrency=1 e2e/real/tui-drag.test.mjs
   ```

   Use `SOKSAK_APP=wailsv3` and `/tmp/soksak-check-tui-repeat-wailsv3` for Wails. Start the matching rebuilt app once against the disposable config before the check. `e2e/app.mjs` connects to an already-running endpoint and does not launch an app. Preserve the original user config. If replacing the currently open Wails user-path process temporarily, use `node e2e/normal-shutdown.mjs` with `SOKSAK_APP=wailsv3` and `SOKSAK_CONFIG_DIR` set to that exact config, start only the disposable instance, shut it down normally, then restore one app on the user config.
6. Read JSON evidence and verify per attempt: current `inputId`; matching pointer result; exact phase; trace overflow; DOM capture/focus; host/window responder; mouse modes; selected cells before input, immediately after, and after the bounded 1000 ms wait; recording frame count/gaps and pixels for the target text cells; and the two `ptyPending` samples with any `ptyPendingError`. A second-sample count of zero proves delivery to the child, not a TUI selection result; a nonzero second sample, or an explicit error, is itself a finding. A screenshot or video without these machine-readable comparisons is not a pass.
7. Compare first failed and first successful attempt at the earliest layer that diverges, using the `ptyPending` samples to separate a successful host write from child receipt. If the queue drains in both, the next target is the TUI's own behavior: determine whether the received SGR down/moves/up reach the TUI input loop and whether transcript selection state changes. Use a tracked exposed diagnostic or a controlled owning-module fixture; do not infer internal selection from host writes or DOM pointer events. Inspect the corresponding TUI transcript/composer routing only as a hypothesis until a measurement distinguishes it.
8. Once the first failing boundary is measured, add the owning-module Red, run it against unchanged production code, fix that boundary, and run the same test Green plus the tracked repeat. Keep the task active until both hosts satisfy every cycle, visual, input, trace, and Shift-control requirement.
9. For every new confirmed finding, update the active `.3.2` checklist and paired changelog before moving to a new task. Update this handoff when the next operator would otherwise lack the current process/evidence state. Run `make docs-check`, focused owning tests, the applicable workspace gates, `make boundaries`, and `make exposure-check` after implementation. Commit only after an item and its evidence are complete; the top-level task is not complete until `.3`–`.6` are complete and both user-path apps are restored with verified identities.

## Known test command behavior and boundaries

- `SOKSAK_TUI_DRAG_DIAGNOSTIC=1` runs one cycle per third-point region and preserves all failures before exiting nonzero. It is a diagnosis target, not the 60-cycle acceptance run.
- Without that variable, the tracked test runs 60 cycles per host (two speeds × three third-point regions × ten repeats) and fails immediately on a failed direct retry.
- The evidence files live in the OS temporary directory; raw recording frames are removed after extraction. Copy a required summary into this document/checklist before temporary JSON files expire, and avoid preserving bulky raw recordings without a specific measurement need.
- The native pointer helper uses real HID and requires trusted access. Never convert a missing permission, app, status, response, or frame into a pass or a skipped assertion.
- `terminal.pty.pending` is declared in `diagnostics.json` and exists only in diagnostic builds, and the pending measurement is transport-level evidence only: a drained queue proves delivery to the child, not interpretation by the program.
- The workaround/measurement is not a product fix. Do not report completion until a measured product correction exists, Red becomes Green, repeat testing passes, both hosts pass the full acceptance, and the binaries opened for the user match the verified build.
