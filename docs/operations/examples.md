# Build and verify applications

[한국어](examples.ko.md)

Run commands from the repository root. Use the package-manager version in `package.json`, a Go toolchain compatible with `apps/wailsv3/go.mod`, and a Rust toolchain compatible with the Tauri crate. Native validation currently runs on macOS with the Command Line Tools SDK and screen-recording permission for capture.

## Native updates

Read the [private native API inventory](private-native-apis.md) before updating native source, frameworks, the SDK, or the OS. If native behavior fails after an update, review that document first. It records active calls, necessity, failure signs, and required verification.

## Build

```sh
make prepare
pnpm build
make wailsv3-build tauriv2-build
```

`native/darwin` builds `libsoksak-darwin.a` and `soksak-darwin.pc` in `native/darwin/build/`. The Makefile adds that directory to `PKG_CONFIG_PATH`; Wails and Tauri locate the headers and link flags through pkg-config. Both native applications require macOS 14.0 because the capture code uses ScreenCaptureKit APIs introduced in macOS 14.0. The Makefile passes this minimum to Go through `CGO_CFLAGS` and `-extldflags`, and to Rust through `MACOSX_DEPLOYMENT_TARGET`.

Run the browser application with `pnpm example` and open `http://localhost:8749/index.html`. Run every package test with `pnpm test`.

The build targets build `native/darwin` and run `pnpm run frontend` in each application. That script stages the workbench, the layout library, the plugin API, the plugins named in `environment.json`, and the application's `runtime/` directory into the generated `frontend/`. Both binaries embed the frontend at build time. A running process does not acquire a newly built frontend; restart the corresponding application after building.

Debug binaries are `apps/wailsv3/bin/soksak-wailsv3` and `apps/tauriv2/target/debug/soksak-tauriv2`. Release builds use `make wailsv3-build-release tauriv2-build-release`. `make examples-size` builds both profiles and reports their sizes.

## Window checks

Start each application once, from separate terminals:

```sh
./apps/wailsv3/bin/soksak-wailsv3 --observe --config-dir /tmp/soksak-check-wailsv3
./apps/tauriv2/target/debug/soksak-tauriv2 --observe --config-dir /tmp/soksak-check-tauriv2
```

Keep the display on and both windows available for rendering. Run:

```sh
pnpm -F @soksak/e2e run verify
```

The harness connects to Wails on `127.0.0.1:49732` and Tauri on `127.0.0.1:49733`. Port `49731` serializes window checks. Tests never start applications or independently activate windows. Project-window checks invoke the application’s project-open command, including its specified creation and focus behavior. A missing running application fails the check; a missing binary is reported as skipped. A run with skipped host tests does not validate both hosts.

`make examples-verify` runs the same checks and the documentation check. Build both applications and restart them before verification. Rebuilding an executable does not replace an already running process.

Use disposable configuration directories: the harness replaces their registry and common settings and creates a `test-project` folder with test-only overrides. The fixture command requires an explicit `--config-dir`. Project-window checks create additional temporary project folders and exercise the normal file and window APIs.

The harness resets the test project and reloads the main document between runs, waits for the initial terminal document and theme, and confirms presentation of the main and visible application documents before capturing. The host supplies drag steps at 16ms intervals. A driven capture receives its first frame before input starts. After presentation is reported, the harness waits for captured terminal bounds to return to their initial coordinates, then sends `stop`. If the final coordinates are missing for 10 seconds, the check fails and retains the recording. A test rejects an incomplete gesture, an incorrect rate, too few frames, or too few measurable frames.

`outside.test.mjs` requires zero surface pixels outside the card on every measurable frame, two complete round trips, and consistent relative positions of terminal content, its DOM input separator, card chrome, the sidebar, and its rail. It also requires repeated main-layout changes within the external document's measured 700ms task interval; merely executing that task is insufficient. `paint.test.mjs` checks unrendered areas. `footer.test.mjs` requires an actual half-point surface height, measures document geometry and hit testing in the final device pixel, and checks footer pixels throughout a vertical divider drag; this check requires a 2× display. `modal.test.mjs` checks ordering, transparency, background blur and input, dismissal, movement, resizing, and reload cleanup. `controls.test.mjs` reads button geometry after maximization and recording. `hosts.test.mjs` compares final requests and displayed geometry; preparation identifiers are local to the owning window.

`projects.test.mjs` checks common and folder settings files, General scope-tab placement, writes from each tab, scope preservation across categories, override reset, library-only Global scope and appearance actions, workspace override restoration, folder aliases, tab/window policy, independent modals, and saved layout and window geometry after native close/reopen. `library.test.mjs` checks window reuse after creation and selection; failed directory operations; actual open status, pins, search, workspace return, and Dock New Window. Preview checks compare card order and split directions with the workspace and require equal row heights, uniform sidebar widths and gaps, and no stored renderer coordinates. `terminal.test.mjs` types into the visible terminal surface, waits for the output line through a DOM mutation observer, and requires the `echo` output once, the project directory from `pwd`, and no output in the other terminal surface. Setting precedence and browser storage transactions are checked by `pnpm test` in `packages/workbench` and `apps/browser`. `make native-test` runs the shared input check and the Wails and Tauri unit checks, including file storage and the sidecar relay.

Failed pixel checks retain raw BGRA frames and write a PNG for the worst alignment, containment, or paint failure. Record at the window’s backing-pixel resolution. Point-sized downsampling blends half-point lines with adjacent pixels and prevents exact color measurement. Raw frames contain three 32-bit values (width, height, row stride), followed by BGRA pixel data. Do not treat a missing or partial recording as a pass.

Finish builds before recording. Raw frame directories and diagnostic images are temporary: inspect failed frames, record the findings in the test log, then delete the recording and images after diagnosis. Do not archive completed recordings.

`geometry.test.mjs` compares native frames, DOM slots, document rectangles, and visual viewports after window resizing and display-scale changes. It uses AppKit hit testing and sends native mouse events to the selected view, waits for pointer-down delivery before release, and checks the resulting DOM coordinates. Display-transition checks require two screens with different scale factors and restore the window position afterward. A skipped display-transition check does not validate that behavior.

## Manual acceptance

- Add two existing project folders, reorder the projects, close the application, and restart it. The library lists the saved projects without starting their surfaces or shells. Select a project and confirm that its layout and settings restore in the same OS window.
- In New Project, cancel the parent-folder chooser once, then select a directory. Creation failure must preserve existing directories. Open the Dock menu and select New Window, including after closing all windows. Return from the workspace to the project list and back; layout and shells must remain available.
- Select Global and Project from the General pane tabs, change a value in each scope, and reset a project override. Confirm inheritance in both windows and scope preservation after changing categories. The opening mode must appear only in Global. Every library screen, including one opened from a workspace, must apply common settings and show only the Global tab. Library edits and the title-bar mode button must leave project overrides unchanged. Returning to the workspace must restore its overrides and both scope tabs.

- Open settings over a browser and terminal. Confirm 50% black shading, visible blur, and clear settings content. Background clicks and scrolling must not operate the underlying content.
- Move settings by its header, resize the main window, and use the window manager. Settings must stay inside the main window. Only × closes settings; background clicks and Escape do not.
- Open add and split pickers. Confirm a transparent background, no blur, and closing by selection, outside click, or Escape.
- Close settings and confirm restored appearance and input. Reload a browser while settings is open and confirm the new document is blurred.
- Record a divider drag and enter/exit fullscreen. Native buttons must remain vertically centered in the first row.

Manual appearance validation confirmed settings blur in both macOS hosts on 2026-09-07. This is manual appearance evidence, separate from automated geometry and input checks. Record new results in [features](../features.md) and [changes](../../CHANGELOG.md); Windows and Linux still require native execution and verification.

## Diagnostics

`--transcript` logs host requests and replies. `--click '5000,button.act[title="설정"]'` requests a DOM click after the specified delay. `--drive 3000,x,2,-250,0,400,2` requests two round trips. `--capture /tmp/frames` records manual layout updates. These flags require `--observe`.

The native probe's `state` operation reports screen scales and window position. The optional `window` field selects an OS window by its reported number; `close` uses its normal close action and save sequence. The observe command `quit` requests normal framework application termination, including pending project saves. `position` uses AppKit global coordinates; `mouse` uses coordinates from the content area's top-left corner with a `down` or `up` phase. Neither operation activates the application. `eval` returns the value of an expression in the webview whose URL contains `match` (`main` selects the main document); `evalAsync` runs a function body and returns the value of its promise.

The standalone overlapping-webview input check uses a temporary native window without activating the application. Run it when changing the shared input code:

```sh
make -C native/darwin test
```

The target builds `native/darwin/build/webview_input_test` against the shared library and runs the baseline and registered-input runs in that order.

The baseline expects duplicate pointer movement in overlapping DOMs. The registered-input run requires exclusive pointer tracking, retained keyboard input, and cleanup after hiding or removing the overlay. Neither run tests delayed cursor responses.
