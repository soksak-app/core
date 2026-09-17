# Build and verify applications

[한국어](examples.ko.md)

Run commands from the repository root. Use the package-manager version in `package.json`, a Go toolchain compatible with `go.work` and `packages/host/wailsv3/go.mod`, and a Rust toolchain compatible with the root `Cargo.toml` workspace. The [native host specification](../spec/hosts.md) describes the host packages, applications, and workspace files. Native validation currently runs on macOS with the Command Line Tools SDK and screen-recording permission for capture.

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

The build targets build `native/darwin`, the workbench, and the sidecars, then run `soksak-stage src/frontend --executables <executable directory>` in each application. The tool stages the workbench, the layout library, the plugin API, the plugins named in `environment.json`, and the application's `runtime/` directory into the generated `apps/<app>/src/frontend/`, and copies the sidecar executables into the executable directory. Both executables embed the frontend at build time. A running process does not acquire a newly built frontend; restart the corresponding application after building.

Debug executables are `target/debug/soksak-wailsv3` and `target/debug/soksak-tauriv2`. Release builds use `make wailsv3-build-release tauriv2-build-release` and write `target/release/soksak-wailsv3` and `target/release/soksak-tauriv2`. `make examples-size` builds both profiles and reports their sizes.

## Window checks

Start each application once, from separate terminals, with the configuration directories the harness reads (`os.tmpdir()` of Node.js, `$TMPDIR` on macOS):

```sh
./target/debug/soksak-wailsv3 --config-dir "$TMPDIR/soksak-check-wailsv3"
./target/debug/soksak-tauriv2 --config-dir "$TMPDIR/soksak-check-tauriv2"
```

Keep the display on and both windows available for rendering. Run:

```sh
pnpm -F @soksak/e2e run verify
```

The harness (`e2e/app.mjs`) connects through `<config-dir>/endpoint.json` with `@soksak/client` ([local endpoint](../spec/endpoint.md)). It checks that `application` names the expected host and that `executable` is the executable of this checkout. A lock file `soksak-check.lock` in the temporary directory prevents two concurrent runs; a second run fails without measuring. Tests never start applications. They read and change state only through declared entries ([exposure](../spec/exposure.md)): status values, commands, DOM entries, host entries, and the diagnostic methods of debug builds. Waits use `status.watch` notifications and `host.window.presented`; the harness has no polling loops or fixed delays. Real input checks use `input.pointer` and `input.key`, which do not activate the application. `make e2e-check` rejects `eval`, the `Function` constructor, the removed native probe, and the removed TCP control port in `e2e/`. A missing running application fails the check; a missing binary is reported as skipped. A run with skipped host tests does not validate both hosts.

`make examples-verify` runs `make e2e-check`, the documentation check, and the window checks. Build both applications and restart them before verification. Rebuilding an executable does not replace an already running process.

Use disposable configuration directories: the harness replaces their registry and common settings and creates a `test-project` folder with test-only overrides. Project-window checks create additional temporary project folders and exercise the normal file and window APIs.

Before each check, the harness closes other windows, restores the 1200×760 start size, runs `diagnostics.fixture`, reloads the main document with `host.window.reload`, waits until every visible terminal surface has registered `core.surface.document` with its theme applied, and confirms presentation. `diagnostics.drag` supplies drag steps from the host at 16ms intervals; with `capture: true` the host records the window from before the first step until the gesture has been presented, and the harness stops the capture with `diagnostics.capture.stop`. A drag that runs outside 1/1.25–1.25 of the requested duration is repeated once and then fails. A test rejects an incomplete gesture, too few frames, or too few measurable frames.

Recordings are temporary. Each check deletes its frame directory when it ends, whether it passed or failed. A failure message reports measurements and frame numbers only; the harness writes no images.

`outside.test.mjs` requires zero surface pixels outside the card on every measurable frame, two complete round trips, and consistent relative positions of terminal content, its DOM input separator, card chrome, the sidebar, and its rail. `paint.test.mjs` checks unrendered areas and requires that every `core.verify` result during the drag has no failed row. `footer.test.mjs` requires an actual half-point surface height, compares the surface document size with `core.surface.document`, checks `core.surface.hit` in the final device pixel, and checks footer pixels throughout a vertical divider drag; this check requires a 2× display. `modal.test.mjs` checks ordering, transparency, background blur (`core.window.document`, `core.surface.document`, `core.modal`), native input routing with `host.hit`, dismissal, movement with native drag input, resizing, and reload cleanup. `controls.test.mjs` reads `host.window` button geometry after maximization and recording. `hosts.test.mjs` compares final requests and displayed geometry from the `diagnostics.transcript` lines; preparation identifiers are local to the owning window.

`projects.test.mjs` checks common and folder settings files, General scope-tab placement, writes from each tab, scope preservation across categories, override reset, library-only Global scope and appearance actions, workspace override restoration, folder aliases, tab/window policy, independent modals, and saved layout and window geometry after native close/reopen. `library.test.mjs` checks window reuse after creation and selection; failed directory operations; actual open status, pins, search, workspace return, and Dock New Window through `host.dock`. Preview checks compare card order and split directions with the workspace and require equal row heights, uniform sidebar widths and gaps, and no stored renderer coordinates. `terminal.test.mjs` clicks the terminal input field and types a line with native input, waits for the line in `terminal.output`, and requires the `echo` output once, the project directory from `pwd`, and no output in the other terminal tab. Setting precedence and browser storage transactions are checked by `pnpm test` in `packages/workbench` and `apps/browser`. `make native-test` runs `make -C native/darwin test`, `go test` for `packages/host/wailsv3` and `sidecars/shell`, and `cargo test -p soksak-host-tauriv2`; the host tests cover file storage, the sidecar relay, and the endpoint.

Record at the window’s backing-pixel resolution. Point-sized downsampling blends half-point lines with adjacent pixels and prevents exact color measurement. Raw frames contain three 32-bit values (width, height, row stride), followed by BGRA pixel data. Do not treat a missing or partial recording as a pass.

`geometry.test.mjs` compares native frames (`host.window`), DOM slots (`core.surfaces`), and surface document and viewport sizes (`core.surface.document`) after window resizing and display-scale changes. It checks the owner of the final device pixel with `host.hit`, presses and releases there with `input.pointer`, and checks the trusted event coordinates in `core.surface.input`. Display-transition checks require two screens with different scale factors (`host.screens`), move the window with `host.window.move`, and restore its position afterward. A skipped display-transition check does not validate that behavior.

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

Debug builds (`make wailsv3-build tauriv2-build`) include the diagnostic methods of the [local endpoint](../spec/endpoint.md): `diagnostics.fixture`, `diagnostics.drag`, `diagnostics.capture.stop`, `diagnostics.knob`, and `diagnostics.transcript`. The `soksak` command and the `soksak-mcp` server send the same requests; for example `soksak status host.window --window main --config-dir DIR`.

`pnpm -F @soksak/client run bench:application -- --config-dir DIR` measures sequential round trips of a running application on three paths: `windows.list` (host only), `status.get core.screen` (relayed to the main page), and `status.get core.surface.document` with a surface (relayed through the main page to a surface page). `bench` measures the transports alone. On 2026-09-17 (M3 Pro, debug builds, 2000 requests per path, two runs) the p50 values were: Wails host 142–157µs, page 1.5–1.7ms, surface 4.4–4.5ms; Tauri host 443µs, page 2.6–2.7ms, surface 1.4–7.5ms.

The shared library has two native input suites. Run both when changing the shared input code:

```sh
make -C native/darwin test
make -C native/darwin test-activation
```

`test` runs `input_inject_test` in a window of an inactive application. It checks presses, drags, scroll, keys, focus, and the inactive result for a move without a button, and it does not activate the application.

`test-activation` activates the test application and therefore takes the keyboard focus. Its windows set `ignoresMouseEvents`, but AppKit still delivers a movement to the tracking areas the real pointer is in. The overlapping-webview check therefore places its window away from the pointer and fails with that reason if the pointer enters the window. It runs `input_activate_test` (hover after activation) and then the overlapping-webview check `webview_input_test`, first as the baseline run and then as the registered-input run.

The baseline expects duplicate pointer movement in overlapping DOMs. The registered-input run requires exclusive pointer tracking, retained keyboard input, and cleanup after hiding or removing the overlay. Neither run tests delayed cursor responses.
