# Native hosts

[한국어](hosts.ko.md)

Core's native side lives in two library packages with the same structure. [Native host interfaces](native-host.md) defines the operations the workbench page uses. [Host contract cases](host-contract.md) lists the behaviors that the tests of both hosts execute.

| Package | Language | Identity |
| --- | --- | --- |
| `packages/host/wailsv3` | Go | Module `github.com/min-median-max/soksak/packages/host/wailsv3`; package `host` in `src/`, imported as `github.com/min-median-max/soksak/packages/host/wailsv3/src` |
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

The shell sidecar uses the same Go mechanism in `sidecars/shell/src/platform/`.

## Platform interface

`src/platform/platform.*` defines the interface that each `src/platform/<os>/` implements. Operations take native window and view handles.

| Area | Operations |
| --- | --- |
| Window | Window preparation, the unified title bar, full screen, the window button area, window server numbers, native inspection requests |
| Webview | Creation, placement, frame, visibility, background, opacity, live resize, close (Wails also navigation, script evaluation, modal configuration and focus, pixel alignment; Tauri also ordering, corner radius, view identity) |
| Surface layout | Transaction begin, commit, cancel, and completion after presentation |
| Surface composition | `SurfaceHost` creation and closure; complete composition application; native-plane clipping, stacking, visibility, and hit routing; image configuration and immutable snapshot presentation |
| Shapes | Outline views above surfaces: creation, frame, style, removal |
| Input | Input monitoring and its removal; Tauri also registers webviews for pointer routing |
| Capture | Window capture: open, start, wait for the first frame, stop |
| Document regions | Creation inside a surface webview, navigation, history actions, placement by insets, dialog blur, close |
| Termination | Termination signals (SIGTERM, SIGINT, SIGHUP): the first one calls the host's quit request; later ones end the process with the default action |
| Window motion | Shortening the window resize animation before any window exists |
| Dock | Dock menu installation |
| Identity | Directory identity |
| Endpoint | [Local endpoint](endpoint.md) transport: Unix socket on macOS; not implemented on Windows |

The webview operation attaches the DOM plane to a `SurfaceHost`, not directly to the window's shared surface container. Document and image operations create descendants of that host's native plane. The platform interface does not expose an operation that can place a region as a sibling of its `SurfaceHost`. Both language hosts validate the [surface composition](surface-composition.md) before calling platform code.

### Window buttons

AppKit owns the window's own buttons. Each host gives its window an empty toolbar with the unified compact style (`windowUnifiedTitlebar`), which makes the title bar 40pt tall and has AppKit centre the buttons in it. The page reads the button area (`chrome.controls()`), reserves its width in the first row, and takes the row height from it: the row is twice the distance from the window top to the centre of the buttons (`--chrome-h` in `packages/workbench/app.css`). `host.window` reports the visible area in `controls`. Moving the buttons into the page's own view is what made AppKit take them back on a title or recording-indicator change, which showed one frame with the buttons missing or at the title bar position in about one of 48 window moves and resizes.

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

The Wails binding service name is `github.com/min-median-max/soksak/packages/host/wailsv3/src.Host`. Wails derives it from the Go package path and type name, and `apps/wailsv3/runtime/index.js` uses it.

## Frontend and executables

`soksak-stage` places the frontend in `apps/<app>/src/frontend/`, which each application's `.gitignore` excludes. Wails embeds it with `//go:embed all:frontend` in `src/main.go` because `go:embed` reaches only files below the embedding package's directory; `host.Run` uses `frontend/` as the asset root. Tauri reads it through `"frontendDist": "src/frontend"` in `tauri.conf.json`, and `src/main.rs` includes `frontend/background.js`.

On macOS each application runs from an application bundle, because the operating system's notification center serves only bundled processes ([plugins](plugins.md#tab-reports)). The debug executables are `target/debug/soksak-wailsv3.app/Contents/MacOS/soksak-wailsv3` and `target/debug/soksak-tauriv2.app/Contents/MacOS/soksak-tauriv2`; release bundles are in `target/release/`. The build writes each bundle's `Contents/Info.plist` from `apps/<app>/platform/darwin/Info.plist`, which names the executable and the bundle identifier (`com.soksak.wailsv3`, `com.soksak.tauriv2`), copies `apps/<app>/platform/darwin/AppIcon.icns`, the soksak icon that the Dock shows, to `Contents/Resources/`, signs the bundle with an ad hoc signature, and registers it again with LaunchServices, because the Dock shows the icon of the registered bundle and LaunchServices does not reread a bundle when only files inside it change. Staging copies sidecar executables into the bundle's `Contents/MacOS/`, and the hosts start sidecars from the directory of the running executable.

## Workspace files

| File | Contents |
| --- | --- |
| `go.work` | Uses `apps/wailsv3`, `packages/host/wailsv3`, and `sidecars/shell`; replaces the host module `v0.0.0` with `./packages/host/wailsv3` |
| `Cargo.toml` | Workspace with members `apps/tauriv2` and `packages/host/tauriv2`, the shared `[patch.crates-io]` for the Tauri crates, and the `dev` profile |
| `Cargo.lock` | The single lock file for both crates |
| `target/` | Cargo output and both application executables; excluded by `.gitignore` |

## Commands

| Command | Action |
| --- | --- |
| `make wailsv3-build`, `make tauriv2-build` | Build `native/darwin`, the frontend, and the sidecars, stage them, and build the debug executable |
| `make wailsv3-build-release`, `make tauriv2-build-release` | Build the release executable |
| `make wailsv3`, `make tauriv2` | Build and run the debug executable |
| `make sidecars-debug`, `make sidecars-release` | Build the sidecar packages the applications declare, and their helpers, in that profile. The build list comes from `scripts/sidecar-packages.mjs`, not from a directory glob |
| `make native-test` | Run `make -C native/darwin test`, `go test` for `packages/host/wailsv3` and `sidecars/shell`, and `cargo test -p soksak-host-tauriv2`, the host tests with and without diagnostics |
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
| `tests/` | `window_motion_test.m`, `input_inject_test.m`, `window_facts_test.m`, `window_controls_test.m`, `surface_layout_test.m`, `webview_focus_test.m`, `webview_geometry_test.m`, and the default run of `document_view_test.m` (`make test`, no activation; `document_view_test` fails if its process is active at exit); `input_activate_test.m`, `webview_input_test.m`, `webview_inspector_test.m`, `window_fullscreen_test.m`, `image_region_ime_test.m`, and `document_view_test.m --activation` (`make test-activation`, activates the application) |
| `Makefile` | Builds a static library that the hosts find through pkg-config as `soksak-darwin`; `make -C native/darwin test` and `make -C native/darwin test-activation` run the input checks |
