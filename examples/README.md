# Examples

## browser

`browser/index.html` is the page. It runs on its own in a browser, where the
surfaces are simulated, and it is the page both applications below run.

    pnpm example        # builds dist/ and serves this directory on :8749

## The applications

Each draws the surfaces with native views of its own. The page is shared:
`sync-frontend.sh` builds each application's `frontend/` from
`browser/index.html` and the library's `dist/`, so a change to either has to be
synced before a build:

    ./examples/sync-frontend.sh

## Tauri v2

    cd examples/tauriv2/src-tauri
    cargo build
    ./target/debug/soksak-tauri

The frontend is embedded at compile time, so a synced page needs a rebuild.

## Wails v3

    cd examples/wailsv3
    go build -o bin/wailsv3 .
    ./bin/wailsv3

The frontend is embedded the same way.

## What each one draws natively

A browser surface is a webview on google.com. A terminal surface is a webview on
a page this application serves, with a shell behind it. A `[data-native-modal]`
element is drawn by a webview of its own, above them.

Only macOS is written. `examples/wailsv3/native_other.go` and
`examples/tauriv2/src-tauri/src/native.rs` say what the other platforms would
use.
