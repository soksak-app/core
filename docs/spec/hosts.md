# Native hosts

[한국어](hosts.ko.md)

This specification is not implemented yet; [feature status](../features.md) tracks its implementation.

Core's native side lives in two host packages with the same structure. [Native host interfaces](native-host.md) defines the operations the workbench page uses.

| Package | Language | Identity |
| --- | --- | --- |
| `packages/host/wailsv3` | Go | Module `soksak/host/wailsv3`, package `host`, import path `soksak/host/wailsv3/src` |
| `packages/host/tauriv2` | Rust | Crate `soksak-host-tauriv2`, `[lib] path = "src/host.rs"` |

The applications `apps/wailsv3` and `apps/tauriv2` contain only `src/main.*`, `environment.json`, `runtime/index.js`, tests, and framework configuration. `src/main.*` calls the host package.

## Host tree

```
packages/host/wailsv3/                     packages/host/tauriv2/
  package.json                               package.json
  go.mod                                     Cargo.toml
  (none: cgo directives use pkg-config)      build.rs              difference H1
  src/                                       src/
    host.go        package documentation, assembly    host.rs
    bindings.go    page call registration             bindings.rs
    windows.go     windows, readiness, close, exit    windows.rs
    projects.go    folder check, choice, creation     projects.rs
    workspace.go   settings and project storage       workspace.rs
    surfaces.go    surface sync, presentation, place  surfaces.rs
    modals.go      native modals                      modals.rs
    shapes.go      outlines above surfaces            shapes.rs
    theme.go       theme storage and delivery         theme.rs
    sidecars.go    sidecar channel                    sidecars.rs
    exposure.go    exposure request relay             exposure.rs
    endpoint.go    JSON-RPC server                    endpoint.rs
    diagnostics.go diagnostics (build tag)            diagnostics.rs
    bridge.js      call channel for additional webviews   difference H3
    platform/                                  platform/
      platform.go  interface and selection       platform.rs
      darwin/                                    darwin/
        darwin.go    package documentation, assembly  darwin.rs
        window.go    window preparation, buttons      window.rs
        webview.go   webview creation, placement      webview.rs
        webview.m    WKWebView creation               difference H4
        layout.go    surface layout transaction       layout.rs
        shapes.go    outline views                    shapes.rs
        input.go     input monitoring, injection      input.rs
        capture.go   capture calls                    capture.rs
        dock.go      Dock menu                        dock.rs
        identity.go  directory identity               identity.rs
        endpoint.go  Unix socket                      endpoint.rs
      windows/                                   windows/
        windows.go     package documentation, assembly  windows.rs
        endpoint.go    named pipe                       endpoint.rs
        identity.go    file ID                          identity.rs
        unsupported.go remaining "not implemented"      unsupported.rs
      linux/  (added when implemented)           linux/
  tests/                                     tests/
    sidecars_test.go                           sidecars_test.rs
    workspace_test.go                          workspace_test.rs
    endpoint_test.go                           endpoint_test.rs
    exposure_test.go                           exposure_test.rs
  test/  (JS: configuration checks)          test/
```

## Rules

- Code is in `src/`. Tests are in `tests/`, and test file names end with `_test` in both languages.
- The primary file of each directory has the directory's name: `host.*`, `platform/platform.*`, `darwin/darwin.*`, `windows/windows.*`.
- Rust modules use `#[path = "..."]` attributes, so the crate has no `lib.rs` or `mod.rs`.
- Platform code exists only under `src/platform/<os>/`, where `os` is `darwin`, `windows`, or `linux`. Rust selects the `darwin` module with `#[cfg(target_os = "macos")]`.
- No stub files exist. An operation that a platform does not implement returns a "not implemented" error from `src/platform/<os>/unsupported.*`.

## Platform interface

`src/platform/platform.*` defines the interface that each `src/platform/<os>/` implements.

| Area | Operations |
| --- | --- |
| Window | Window preparation, window buttons |
| Webview | Creation, placement, visibility, background, close |
| Surface layout | Transaction begin, commit, cancel, and completion after presentation |
| Shapes | Outline shapes above surfaces |
| Input | Input monitoring and native input injection |
| Capture | Window capture |
| Dock | Dock menu |
| Identity | Directory identity |
| Endpoint | [Local endpoint](endpoint.md) transport |

## Allowed differences

| ID | Wails | Tauri | Reason |
| --- | --- | --- | --- |
| H1 | none | `build.rs` | Rust runs pkg-config and Objective-C compilation in a build script; Go uses cgo directives |
| H3 | `bridge.js` | none | Wails provides no call channel to webviews that the application creates |
| H4 | `platform/darwin/webview.m` | none | Wails has no child-webview API, so the host creates the webview in Objective-C; Tauri uses `add_child` |
| A1 | content differs | content differs | `runtime/index.js` uses each framework's call mechanism |
| A2 | none | `build.rs` | Tauri requires `tauri_build::build()` |
| A3 | none | `tauri.conf.json`, `capabilities/`, `icons/`, `gen/` | Tauri configuration |
| A4 | `go.mod` | `Cargo.toml` | Each language has its own manifest; the host packages have the same difference |

## Application tree

```
apps/wailsv3/                  apps/tauriv2/
  package.json                   package.json
  environment.json               environment.json
  runtime/index.js               runtime/index.js      difference A1
  test/                          test/
  src/main.go                    src/main.rs
  go.mod                         Cargo.toml            difference A4
  (none)                         build.rs              difference A2
  (none)                         tauri.conf.json, capabilities/, icons/, gen/   difference A3
```

## Structure check

`scripts/check-hosts.mjs`, run by `make hosts-check`, compares the two host trees and the two application trees by relative path without extension. The check passes only when every difference is in the allowed differences table.

## native/darwin

`native/darwin` is the shared macOS library that both hosts call.

| Path | Contents |
| --- | --- |
| `src/` | `<name>.h` and `<name>.m` sources. File names have no `_darwin` suffix because the directory identifies the platform |
| `tests/` | Native tests |
| `Makefile` | Builds a static library that the hosts find through pkg-config as `soksak-darwin` |
