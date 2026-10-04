# Native hosts

[한국어](hosts.ko.md)

Core's native side lives in two library packages with the same structure. [Native host interfaces](native-host.md) defines the operations the workbench page uses. [Host contract cases](host-contract.md) lists the behaviors that the tests of both hosts execute.

| Package | Language | Identity |
| --- | --- | --- |
| `packages/host/wailsv3` | Go | Module `github.com/soksak-app/core/packages/host/wailsv3`; package `host` in `src/`, imported as `github.com/soksak-app/core/packages/host/wailsv3/src` |
| `packages/host/tauriv2` | Rust | Crate `soksak-host-tauriv2`, `[lib] path = "src/host.rs"` |

The applications `apps/wailsv3` and `apps/tauriv2` contain only `src/main.*`, `environment.json`, `runtime/index.js`, tests, manifests, and framework configuration. `apps/wailsv3/src/main.go` reads the command-line flags into `host.Options` and calls `host.Run(assets, options)`. `apps/tauriv2/src/main.rs` calls `soksak_host_tauriv2::run(tauri::generate_context!(), BACKGROUND)`, where `BACKGROUND` is the staged `frontend/background.js`.

## Host tree

```
packages/host/wailsv3/                     packages/host/tauriv2/
  package.json                               package.json
  go.mod, go.sum                             Cargo.toml            difference A4
  (none: cgo directives use pkg-config)      build.rs              difference H1
  src/                                       src/
    host.go        package documentation, Run         host.rs
    bindings.go    page call registration             bindings.rs
    windows.go     windows, readiness, close, exit    windows.rs
    projects.go    folder check, choice, creation     projects.rs
    workspace.go   settings and project storage       workspace.rs
    surfaces.go    surface sync, presentation, place  surfaces.rs
    documents.go   document regions of surfaces       documents.rs
    modals.go      native modals                      modals.rs
    shapes.go      outlines above surfaces            shapes.rs
    theme.go       theme storage and delivery         theme.rs
    sidecars.go    sidecar channel                    sidecars.rs
    exposure.go    exposure request relay             exposure.rs
    endpoint.go    JSON-RPC server                    endpoint.rs
    termination.go termination requests             termination.rs
    diagnostics.go diagnostic methods (build tag)     diagnostics.rs
    recording.go   diagnostic recording state (build tag) recording.rs
    bridge.js      call channel for additional webviews   difference H3
    platform/                                  platform/
      platform.go  interface and selection       platform.rs
      darwin/                                    darwin/
        darwin.go    package documentation, registration  darwin.rs
        window.go    window preparation, buttons      window.rs
        webview.go   webview creation, placement      webview.rs
        webview.m    WKWebView creation               difference H4
        document.go  document region views            document.rs
        layout.go    surface layout transaction       layout.rs
        ui_queue.go  completion outside event locks   ui_queue.rs
        shapes.go    outline views                    shapes.rs
        input.go     input monitoring                 input.rs
        capture.go   capture calls (build tag)        capture.rs
        dock.go      Dock menu                        dock.rs
        identity.go  directory identity               identity.rs
        endpoint.go  Unix socket                      endpoint.rs
        termination.go termination signals            termination.rs
      windows/                                   windows/
        windows.go     package documentation, registration  windows.rs
        identity.go    file ID                          identity.rs
        unsupported.go "not implemented" operations, including the named-pipe endpoint  unsupported.rs
      linux/  (added when implemented)           linux/
  tests/                                     tests/
    sidecars_test.go                           sidecars_test.rs
    recording_test.go (build tag)              recording_test.rs (feature)
    workspace_test.go                          workspace_test.rs
    endpoint_test.go                           endpoint_test.rs
    exposure_test.go                           exposure_test.rs
    documents_test.go                          documents_test.rs
    termination_test.go                        termination_test.rs
```

## Rules

- Code is in `src/`. Tests are in `tests/`, and test file names end with `_test` in both languages. Go tests in `tests/` import the host package; Cargo builds each `tests/*_test.rs` file as an integration test of the crate.
- The primary file of each directory has the directory's name: `host.*`, `platform/platform.*`, `darwin/darwin.*`, `windows/windows.*`.
- Rust modules use `#[path = "..."]` attributes, so the crate has no `lib.rs` or `mod.rs`.
- Platform code exists only under `src/platform/<os>/`, where `os` is `darwin`, `windows`, or `linux`.
- No stub files exist. An operation that a platform does not implement returns an error from `src/platform/<os>/unsupported.*`.
- A C name that `native/darwin` exports starts with `sp_` when a framework exports the same name. Wails compiles its own `windowFullscreen`, and the linker picked one of the two: the call reached the framework's function and the host read its return value as a failure.

## Platform selection

Go: each `src/platform/<os>/` directory is a Go package. Its primary file (`darwin.go`, `windows.go`) has no build tag and contains only the package documentation; the other files have a `//go:build <os>` tag, and one of them calls `platform.Register` from `init`. `host.go` imports every OS package with a blank import, so a build registers only the implementation for its target OS. `host.Run` obtains it with `platform.Current()` and fails when no implementation is registered.

Rust: `src/platform/platform.rs` declares each OS module with `#[cfg(target_os = "macos")]` or `#[cfg(windows)]` and `#[path = "<os>/<os>.rs"]`. `platform::current()` returns the implementation for the target OS and returns an error on other targets. Each OS module declares its own files with `#[path]`.

The shell sidecar repository uses the same Go mechanism in its `src/platform/` ([repositories](plugins.md#repositories)).

## Platform interface

`src/platform/platform.*` defines the interface that each `src/platform/<os>/` implements. Operations take native window and view handles.

| Area | Operations |
| --- | --- |
| Window | Window preparation, the title bar height, full screen, the window button area, window server numbers, native inspection requests |
| Webview | Creation, placement, frame, visibility, background, opacity, live resize, close (Wails also navigation, script evaluation, modal configuration and focus, pixel alignment; Tauri also ordering, corner radius, view identity) |
| Surface layout | Transaction begin, commit, cancel, and completion after presentation |
| Surface composition | `SurfaceHost` creation and closure; complete composition application; native-plane clipping, stacking, visibility, and hit routing; image configuration and immutable snapshot presentation |
| Shapes | Outline views above surfaces: creation, frame, style, removal |
| Input | Input monitoring and its removal; Tauri also registers webviews for pointer routing |
| Capture | Window capture: open, start, wait for the first frame, stop |
| Document regions | Creation inside a surface webview, navigation, history actions, placement by insets, dialog blur, close |
| Termination | Termination signals (SIGTERM, SIGINT, SIGHUP): the first one calls the host's quit request; later ones end the process with the default action. The quit request kills every window's web process first — see [Process lifecycle](#process-lifecycle) |
| Quit request | The operating system's quit request (the `kAEQuitApplication` Apple event of the Dock, a logout, a restart or another program) runs the same quit as `host.quit`, including the saves of ready windows, and the host answers the request without an error just before the process ends, after the saves and the shutdown steps. The application framework's own quit path is not used for it, because the Wails framework answers a quit it delays with a cancellation, which also stops a logout, and the Tauri framework ends without the page-save wait |
| Window motion | Shortening the window resize animation before any window exists |
| Standard error | Replacing the process's standard error with an open file — see [Application log](#application-log); not implemented on Windows |
| Dock | Dock menu installation |
| Identity | Directory identity |
| Endpoint | [Local endpoint](endpoint.md) transport: Unix socket on macOS; not implemented on Windows |

Capture first-frame readiness succeeds only after a complete frame is written and no recording error is known at the readiness check. A known asynchronous start or stream failure rejects readiness even when that frame exists; the original error remains available to the caller.

Still capture returns its own caller-owned error string, freed with free(), separately from recording errors. A failed still capture neither clears an existing recording error nor makes a healthy recording fail. Invalid UTF-8 paths are rejected before platform APIs. Late still callbacks retain only their own call state and cannot change recording results. The native sp_capture_still error output pointer is mandatory; success sets its value to NULL, and failure allocates a UTF-8 error string. Both hosts consume and free that per-call output rather than reading sp_capture_error.

Recording target preparation and start reject an already active recording before changing target, frame counters or recording errors. Each open/start call returns a separate caller-owned UTF-8 error through a mandatory output pointer (NULL on success; free() on failure). Rejected overlapping operations cannot invalidate healthy recording readiness or erase an earlier recording failure.

Target preparation publishes a filter and configuration only when its own query completes successfully within the 10000ms limit. A timed-out query retains only its own callback state; a late failure is reported and a late success cannot overwrite a later target. Preparation releases obsolete inactive target/configuration ownership instead of retaining unused objects. Preparation errors are returned through its per-call output and do not change recording errors. If a recording becomes active before successful preparation is published, the call rejects that publication and preserves the active recording.

Each failed frame-file open, write, close or commit reports its own operation, frame path and captured system error. A failed partial-file removal reports an additional recording error without replacing the original failure. Close is still attempted after a write failure, and its failure is reported separately. Removal is attempted only for a file successfully opened by the writer; an open failure cannot delete a pre-existing path. A failed frame never increments the written count or signals first-frame readiness.

An asynchronous start or delegate-stop failure changes recording errors only when it identifies the current stream. A delayed failure from an earlier stream is reported with its stream identity and cannot change later recording errors or first-frame readiness. Start completion retains its original stream identity through delivery; it must not read the identity of a replacement stream as its own.

The webview operation attaches the DOM plane to a `SurfaceHost`, not directly to the window's shared surface container. Document and image operations create descendants of that host's native plane. The platform interface does not expose an operation that can place a region as a sibling of its `SurfaceHost`. Both language hosts validate the [surface composition](surface-composition.md) before calling platform code.

### Window buttons

AppKit owns the window's own buttons. The title bar height decides where AppKit places them: AppKit centres the buttons vertically in the title bar and keeps them there after a title change, a resize, and a move. Each host sets the title bar height with AppKit's `-[NSWindow setTitlebarHeight:]` (`windowSetTitlebarHeight`, listed in the [private native API inventory](../operations/private-native-apis.md)); the window has no toolbar. Each host sets the height to 40pt when it creates the window, before the window becomes visible.

The page owns the height of its first row: `--chrome-row` in `packages/workbench/app.css` is `round(max(--chrome-h, 36px × frame factor))`, where `--chrome-h` is the fixed 40px minimum and the frame factor is the [text size](text-size.md) of the frame. The page does not take the row from the window's answer, so a change of the title bar does not change the row. When the row height differs from the title bar, the page requests the row height with the `windowTitlebar` host call and reads `chrome.controls()` again (`packages/workbench/titlebar.js`); because the row does not depend on the answer, the title bar equals the row after one request and the next comparison requests nothing. The page compares on start, on every window resize, and when the frame factor changes. The page reads the button area from the same answer and reserves its width in the first row. `host.window` reports the visible area in `controls`.

`windowTitlebar` takes `height`, a number of points from 32 through 200; both hosts reject another value with `title bar height must be a finite number from 32 through 200 points`. A window without standard buttons or a content view fails with `the window has no standard buttons or content view for a title bar`. A window in full screen shows no title bar: its row is 0, the page sends no height, and a request that arrives during full screen fails with `the window shows no title bar in full screen`, because AppKit saves the height when the window enters full screen and restores it when the window leaves, which would discard a height set in between. Leaving full screen resizes the window, and the page then requests its row again.

Moving the buttons into the page's own view is what made AppKit take them back on a title or recording-indicator change, which showed one frame with the buttons missing or at the title bar position in about one of 48 window moves and resizes. The title bar height does not come from a toolbar: an empty toolbar with the unified compact style fixes the title bar at 40pt, so the buttons would leave the centre of a first row that the frame factor enlarges.

## Windows state

On Windows both hosts implement only directory identity (`platform/windows/identity.*`). Every other operation in `platform/windows/unsupported.*` returns an error of the form `<operation> is not implemented on windows`. Application startup fails on Windows: Wails `Run` and Tauri's endpoint setup return the termination-request error before any window opens. Linux has no implementation; `platform.Current()` and `platform::current()` return an error there.

## Allowed differences

| ID | Wails | Tauri | Reason |
| --- | --- | --- | --- |
| H1 | none | `build.rs` | Rust locates `native/darwin` through pkg-config (`soksak-darwin`) in a build script on macOS targets; Go uses the `#cgo pkg-config` directive |
| H3 | `src/bridge.js` | none | Wails provides no call channel to webviews that the application creates |
| H4 | `src/platform/darwin/webview.m` | none | Wails has no child-webview API, so the host creates the webview in Objective-C; Tauri uses `add_child` |
| H5 | `src/diagnostics_test.go` | none | The diagnostic-only Go unit test is colocated with the implementation to test the unexported capture payload helper without widening the host API; Rust diagnostic coverage is in the host's integration tests |
| H6 | `src/menu.go`, `tests/menu_test.go` | none | The Wails default application menu zooms and reloads the whole main webview from its View menu, so the Wails host defines its application menu; the Tauri host uses Tauri's default menu, whose View menu has only full screen |
| A1 | content differs | content differs | `runtime/index.js` uses each framework's call mechanism |
| A2 | none | `build.rs` | Tauri requires `tauri_build::build()` |
| A3 | none | `tauri.conf.json`, `capabilities/`, `icons/`, `gen/` | Tauri configuration |
| A4 | `go.mod`, `go.sum` | `Cargo.toml` | Each language has its own manifest; the host packages have the same difference |
| C1 | `src/cmd/sok/main.go` | `src/main.rs` | A Go command needs its own `main` package directory; a Rust binary target is `src/main.rs` beside the library root |
| C2 | `src/diagnostics_test.go`, `tests/build_test.go` | none | A Go file belongs to one build by its build constraint, so the diagnostic build of `sok` tests its `capture` request and its `.dev` identifier in a `diagnostics`-tagged unit test and the other build tests the usage error and the release identifier in a `!diagnostics` test; Rust tests both builds with `cfg(feature = "diagnostics")` in `tests/sok_test.rs` |

## Process lifecycle

The hosts own three child-process families, each with one rule.

**WebKit XPC die with the application.** Every exit path kills each window's WebContent process through the native `_killWebContentProcessAndResetState` before the process ends: a termination signal kills them and the Tauri host then exits immediately (`std::process::exit(0)`), because the graceful exit path waits on a ready window's save and a termination signal is a forced exit; the Wails host ends through its normal quit, whose shutdown step kills them the same way. Without the kill, macOS keeps the WebContent, GPU, and Networking processes alive after the client dies.

Crash leftovers are accepted until the operating system reclaims them. A startup cleanup was tried and removed as unsound (measured 2026-09-30): live WebKit of a running application also shows no unix sockets on this system, so socket presence discriminates nothing, WebKit XPC ignore SIGTERM, and the only sound ownership proof — a Networking process holding the owning bundle's `WebsiteData` store open — identifies a minority of an orphan group, because the memory-heavy WebContent holds no identifiable path. A cleanup that cannot prove which WebKit belong to dead applications must not run.

**Persistent sidecars outlive the application and reconnect.** The terminal service keeps its sessions across application restarts and connection losses; a lost connection is revived at once and a dead service respawned ([terminal runtime](terminal-runtime.md)). The application never kills a persistent service on exit.

**Non-persistent sidecars die with their window.** Removing a surface or closing its window sends the close notice; the process ends with the channel.

## Application log

Each host writes its application log to `logs/application.log` under the configuration directory. Right after the host creates its [endpoint](endpoint.md), which holds the process lock of the configuration directory, it opens that file for appending with mode 0600 and makes the file the standard error of the process through the platform standard-error operation. The file then holds the host's own lines, each page line sent through `report`, the runtime's crash output, and the standard error of every non-persistent sidecar, which inherits the descriptor. A line is in the file when the write that produced it returns. Both hosts write their own lines and the page lines without a prefix; each run starts the log with the line `<ISO-8601 time> application log: <application identifier> pid <pid>`, which carries the time. Output written before the endpoint exists goes to the standard error that the process was started with.

A page line that states an error starts with `error: `, and a page line that does not start with it is information. The workbench reports in this form every error it shows in the main document, every unhandled error and promise rejection, every refused status change, every failed surface mount or background session, and every failed self verification (`error: verify: <n> fail — …`). The log keeps each error line after a later reload removes the error from the document, so a window check judges every error occurrence from the log. A page without a host writes a failure to its console as an error.

A host line that states an error has the same form, `error: <where>: <text>`: `<where>` names the operation or the object that failed and `<text>` is the failure. Each host writes it through one helper (`LogError` in Go, `log_error` in Rust), and a site that both hosts have writes the same `<where>` and `<text>` in both. The native library writes its error lines in the same form through `sp_log_error`. A fatal failure after the log is open writes its line in this form before the process ends. A host line that does not start with `error: ` is an observation: it records an expected state and states that state, for example `exposure reply <id> of removed surface "<surface>" arrived after its request ended`, or `<operation> arrived after its request ended`, which a completion writes when its caller has already returned its own failure. A host does not write a failure as an observation. The error output of the application framework goes through the same helper (`error: wails: <text>`); the Tauri runtime has no logger installed.

A persistent service outlives the host that started it, so it does not inherit the host's standard error. When a host starts a persistent service, it opens `logs/<executable-name>.log` for appending with mode 0600 and passes that file as the service's standard error.

When a host opens a log file of 10 MB or more, it first renames the file to `<name>.1`, which replaces the previous generation, and starts a new file. A host opens a log file only when no other process writes to it: it opens the application log once per run while it holds the process lock, and a service log only when it starts that service. A run or a service appends without a size limit until the next open, so the next run or service start applies the bound.

A host that cannot open its application log or replace its standard error does not start, and it reports the error on the standard error that it was started with. A host that cannot open a service log does not start that service and fails the start with `sidecar <name>: service log: <error>`.

## Application tree

```
apps/wailsv3/                  apps/tauriv2/
  package.json                   package.json
  environment.json               environment.json
  runtime/index.js               runtime/index.js      difference A1
  test/                          test/
  src/main.go                    src/main.rs
  src/frontend/  (generated)     src/frontend/  (generated)
  go.mod, go.sum                 Cargo.toml            difference A4
  (none)                         build.rs              difference A2
  (none)                         tauri.conf.json, capabilities/, icons/, gen/   difference A3
```

`apps/wailsv3/go.mod` requires the host module. `apps/tauriv2/Cargo.toml` depends on `soksak-host-tauriv2` by path and on `tauri`. `apps/tauriv2/build.rs` calls only `tauri_build::build()`.

The Wails binding service name is `github.com/soksak-app/core/packages/host/wailsv3/src.Host`. Wails derives it from the Go package path and type name, and `apps/wailsv3/runtime/index.js` uses it.

## Command line tree

```
packages/sok/wailsv3/          packages/sok/tauriv2/
  src/sok.go  (package sok)      src/sok.rs  (library root)
  src/<role>.go                  src/<role>.rs
  src/cmd/sok/main.go            src/main.rs           difference C1
  tests/<role>_test.go           tests/<role>_test.rs
  go.mod, go.sum                 Cargo.toml            difference A4
```

The pair follows the same file-name rule and structure check as the host packages. Its contract cases are listed in [host contract](host-contract.md) under `cli.`.

## Application arguments

An application accepts `--config-dir PATH` ([projects](projects.md#persistence)), written as two arguments or as `--config-dir=PATH`. Both hosts read the arguments with one rule before any window opens: an argument that the application does not declare fails with `unknown argument <argument>`, a flag without a value fails with `--<flag> needs a value`, and a repeated flag fails with `--<flag> is given twice`; the application writes the message to its standard error and ends with status 2.

A diagnostic build also accepts `--registry-ca PATH`: a PEM file whose certificate authorities the host's registry fetches trust instead of the operating system's ([fetching](installation.md#fetching)), so a window check can serve a local TLS registry. A file that cannot be read or holds no certificate ends the start with `--registry-ca <path>: <reason>` and status 2. A release build does not declare the argument and rejects it as unknown.

## Frontend and executables

`soksak-stage` places the frontend in `apps/<app>/src/frontend/`, which each application's `.gitignore` excludes. Wails embeds it with `//go:embed all:frontend` in `src/main.go` because `go:embed` reaches only files below the embedding package's directory; `host.Run` uses `frontend/` as the asset root. Tauri reads it through `"frontendDist": "src/frontend"` in `tauri.conf.json`, and `src/main.rs` includes `frontend/background.js`.

On macOS each application runs from an application bundle, because the operating system's notification center serves only bundled processes ([plugins](plugins.md#tab-reports)). Both release applications are `soksak.app` with the display name `soksak`: the release bundles are `target/release/wailsv3/soksak.app` and `target/release/tauriv2/soksak.app`, and their bundle identifiers are `app.soksak.wails` and `app.soksak.tauri`, the identifiers of the configuration directories ([projects](projects.md#persistence)). The debug bundles keep the names that let both run beside a release application: `target/debug/soksak-wailsv3.app/Contents/MacOS/soksak-wailsv3` and `target/debug/soksak-tauriv2.app/Contents/MacOS/soksak-tauriv2`, with the bundle name of the executable and the identifiers `app.soksak.wails.dev` and `app.soksak.tauri.dev`. The executable inside each bundle is `soksak-wailsv3` or `soksak-tauriv2`. The build writes each bundle's `Contents/Info.plist` from `apps/<app>/platform/darwin/Info.plist`, which declares the release values, and the debug build replaces the bundle identifier and the bundle name; it copies `apps/<app>/platform/darwin/AppIcon.icns`, the soksak icon that the Dock shows, to `Contents/Resources/`, signs the bundle with an ad hoc signature, and registers it again with LaunchServices, because the Dock shows the icon of the registered bundle and LaunchServices does not reread a bundle when only files inside it change. The bundle holds no plugin and no sidecar; the hosts serve the plugins and start the sidecars that are installed in the configuration directory, from the folders that `plugins/installed.json` records ([installation](installation.md#serving-installed-plugins)).

## Workspace files

| File | Contents |
| --- | --- |
| `go.work` | Uses `apps/wailsv3`, `packages/host/wailsv3` and `packages/sok/wailsv3`; replaces the host module and the command-line module `v0.0.0` with `./packages/host/wailsv3` and `./packages/sok/wailsv3` |
| `Cargo.toml` | Workspace with members `apps/tauriv2`, `packages/host/tauriv2` and `packages/sok/tauriv2`, the shared `[patch.crates-io]` for the Tauri crates, and the `dev` profile |
| `Cargo.lock` | The single lock file for both crates |
| `target/` | Cargo output and both application executables; excluded by `.gitignore` |

## Commands

| Command | Action |
| --- | --- |
| `make wailsv3-build`, `make tauriv2-build` | Build `native/darwin` and the frontend, stage it, and build the debug executable |
| `make wailsv3-build-release`, `make tauriv2-build-release` | Build the release executable |
| `make wailsv3`, `make tauriv2` | Build and run the debug executable |
| `make registry`, `make install-plugins CONFIG=DIR` | Build the workspace registry in `target/registry` from the plugin and sidecar repositories that `scripts/workspace-registry.json` declares ([repositories](plugins.md#repositories)), and install its plugins into a configuration directory |
| `make rust-clippy-check` | Run clippy with `-D warnings` on every package and test of the Rust workspace, with and without the diagnostics feature; `make native-test` runs it |
| `make native-test` | Run `make -C native/darwin test`, `go test` for `packages/host/wailsv3`, and `cargo test -p soksak-host-tauriv2`, the host tests with and without diagnostics; each sidecar repository runs its own tests |
| `make platforms` | Run `scripts/check-platforms.mjs` |
| `make hosts-check` | Run `scripts/check-hosts.mjs` |

## Structure checks

`scripts/check-hosts.mjs` compares `packages/host/wailsv3` with `packages/host/tauriv2` and `apps/wailsv3` with `apps/tauriv2`. It compares `.go` and `.rs` files by relative path without extension and other files by relative path. A file present on one side passes only when it is listed with a difference ID from the allowed differences table. The check reads files that Git tracks or would track, so generated `src/frontend/` files are not compared.

`scripts/check-platforms.mjs` reports these outside `platform/<os>/` directories: file names with an OS suffix (`_darwin`, `_windows`, and others) and, in source files, `runtime.GOOS`, Go OS build tags, Rust OS `cfg` attributes, and `process.platform`. It skips `native/<os>/`, `scripts/check-build-environment.sh`, `platform/platform.{go,rs,js}`, and itself. It does not read `Cargo.toml`, so target-specific dependency tables are allowed.

## native/darwin

`native/darwin` is the shared macOS library that both hosts call. Its minimum macOS version is 14.0.

| Path | Contents |
| --- | --- |
| `src/` | `<name>.h` and `<name>.m` sources, including `capture.m`, which both hosts use for window capture. File names have no `_darwin` suffix because the directory identifies the platform |
| `tests/` | `window_motion_test.m`, `input_inject_test.m`, `webview_input_receipts_test.m`, `window_facts_test.m`, `window_controls_test.m`, `surface_layout_test.m`, `webview_focus_test.m`, `webview_geometry_test.m`, and the default run of `document_view_test.m` (`make test`, no activation; `document_view_test` fails if its process is active at exit); `input_activate_test.m`, `webview_input_test.m`, `webview_inspector_test.m`, `window_fullscreen_test.m`, `image_region_ime_test.m`, and `document_view_test.m --activation` (`make test-activation`, activates the application) |
| `Makefile` | Builds a static library that the hosts find through pkg-config as `soksak-darwin`; `make -C native/darwin test` and `make -C native/darwin test-activation` run the input checks |
