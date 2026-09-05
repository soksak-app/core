# Examples

## browser

`browser/index.html` is the page. It runs on its own in a browser, where the
surfaces are simulated, and it is the page both applications below run.

    pnpm example        # builds dist/ and serves the repository on :8749
                        # http://localhost:8749/examples/browser/index.html

## The applications

Each draws the surfaces with native views of its own. The page is shared and is
copied whole into each application's `frontend/`, together with `dist/` and that
application's own `host.js`, `overlay.html` and `terminal.html`. Nothing is
rewritten: the page is servable as it is, and `host.js` is the one thing an
environment supplies.

The copy is a make target, because `go:embed` cannot reach outside its module
and both applications embed the frontend at compile time:

    make example-frontend

Each application builds and runs in either profile, and the make targets do the
copy first:

    make tauri              make wails              # debug, then run
    make tauri-release      make wails-release      # release, then run
    make tauri-build        make wails-build        # build only
    make tauri-build-release  make wails-build-release

    make examples-size      # both, both profiles, and what each weighs

The binaries land in `examples/tauriv2/src-tauri/target/` and
`examples/wailsv3/bin/`.

## What each one draws natively

A browser surface is a webview on google.com. A terminal surface is a webview on
a page this application serves, with a shell behind it. A `[data-native-modal]`
element is drawn by a webview of its own, above them.

Only macOS is written. `examples/wailsv3/native_other.go` and
`examples/tauriv2/src-tauri/src/native.rs` say what the other platforms would
use.
