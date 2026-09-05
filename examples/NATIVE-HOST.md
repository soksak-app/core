# The native host, and where it should live

Draft. Korean translation: [`NATIVE-HOST.ko.md`](NATIVE-HOST.ko.md).

`examples/wailsv3` and `examples/tauriv2` each implement the same three
contracts. This document states what they are, what is already shared, and what
it would take to publish them as a Wails service and a Tauri plugin.

## What the page asks for

Three interfaces, all installed on `window` by `host.js` and absent in a plain
browser.

`hostSurfaces` — a webview per surface, placed on the frames the page declares.

    kinds                the plugin kinds the host draws, so the page stops
                         simulating those
    report(line)         one line into the application's log
    theme(values)        the token values, for the pages the host serves
    place(record)        every surface's id, url, frame, visibility and dim,
                         once per commit

`hostShapes` — a rectangle above the surfaces, drawn by a layer-backed view.

    set(id, rect, style) frame, corner radius, line width, fill and line colour
    clear(id)

`hostOverlay` — one `[data-native-modal]` element, drawn by a webview above the
surfaces.

    show(el, rect, onPick)   the element's class, markup and stylesheet
    place(rect)              a new frame while it is open
    update(el)               new content while it is open
    hide()

Two things travel back: `surface-pressed`, which names the surface an input
landed on, and `overlay-pick`, which carries one `(key, value)` from the modal.

## What is already one implementation

`examples/browser/host.js` is one file. It builds every payload, mixes the
colours, drops a request identical to the last one, and installs the three
interfaces. It names no application.

`examples/browser/framework/` holds the difference between the runtimes: how a
call is made, how an event is received, and how a page this host serves is
addressed. One file per runtime, four exports each.

`terminal.html` and `overlay.html` are one copy each and ask `framework/` which
runtime is holding them.

## What is duplicated

The two hosts. Both implement the same operations against the same platform:

| Operation | Wails, Go + cgo | Tauri, Rust + objc2 |
| --- | --- | --- |
| create a surface | `surfaceCreate`, a WKWebView in the content view | `window.add_child` |
| move, resize, hide | `surfaceSetFrame`, `surfaceResize`, `surfaceSetHidden` | `set_position`, `set_size`, `hide` |
| dim | `surfaceSetAlpha` | `native::alpha` |
| round the corners | `surfaceSetCornerRadius` | `native::corners` |
| identify a pressed view | `surfaceWatchMouse` + `hitTest:` | `native::watch_mouse` |
| a shape above the surfaces | `shapeCreate`, `shapeSetStyle` | `native::shape_*` |
| serve the local pages | `serve.go`, a loopback server | the app's own scheme |
| run a shell | `shell.go` | `shell.rs` |

Only macOS is written on either side. Windows and Linux are named in
`native_other.go` and `native.rs` and are not implemented.

## What a plugin would be

**Wails.** A service, registered like `main.Surfaces` is today. It would export
`SyncSurfaces`, `SetShape`, `ClearShape`, `OverlayShow`, `OverlayPlace`,
`OverlayUpdate`, `OverlayHide`, `SetTheme` and `Report`, and emit
`surface-pressed` and `overlay-pick`. The cgo in `native_darwin.go` and the
loopback server in `serve.go` move with it.

**Tauri.** A plugin crate, `tauri-plugin-native-surfaces`. The commands are the
same list in snake case. Tauri plugins carry their own JavaScript, so
`host.js` and `framework/tauriv2.js` would ship inside the plugin rather than
beside the page.

**The page.** `host.js` and `framework/` are the JavaScript half of the same
contract. If the two plugins each ship their own copy, the contract is written
three times instead of two. The alternative is one npm package that both
plugins depend on.

## Where it should live

Not in this repository. `soksak` is a layout library: it computes rects and
places elements, and it owns no DOM policy, no application state and no native
code. Native compositing is a different product that happens to be the example's
host.

A separate repository would hold the two plugins and the JavaScript package,
and this repository's examples would depend on them. Until that exists, the code
stays here, where it is exercised.

## What is not decided

- Whether the page's three interfaces stay three, or become one namespace.
- Whether the shell belongs in the same plugin. It is a terminal feature, not a
  compositing one, and it is here only because the terminal surface needs it.
- What Windows and Linux do. Both are named in the two native files and neither
  is written, so no platform has been designed for, only macOS.
