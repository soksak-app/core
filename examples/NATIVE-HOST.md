# The native host, and where it should live

Draft. Korean translation: [`NATIVE-HOST.ko.md`](NATIVE-HOST.ko.md).

`examples/wailsv3` and `examples/tauriv2` each implement the same three
contracts. This document states what they are, what is already shared, and what
it would take to publish them as a Wails service and a Tauri plugin.

## What the page requires

Three interfaces, all exported by `host.js`. In a plain browser each one is
present and does nothing, and `native` is false.

`surfaces` — a webview per surface, placed on the frames the page declares.

    kinds                the plugin kinds the host draws, so the page stops
                         simulating those
    report(line)         one line into the application's log
    theme(values)        the token values, for the pages the host serves
    place(record)        every surface's id, url, frame, visibility and dim,
                         once per commit

`shapes` — a rectangle above the surfaces, drawn by a layer-backed view.

    set(id, rect, style) frame, corner radius, line width, fill and line colour
    clear(id)

`chrome` — the window itself. Neither window has a frame, so the application
draws the buttons and marks what drags it.

    draggable(el)            dragging this element moves the window
    close(), minimise(), toggleMaximise()

`overlay` — one `[data-native-modal]` element, drawn by a webview above the
surfaces.

    show(el, rect, onPick)   the element's class, markup and stylesheet
    place(rect)              a new frame while it is open
    update(el)               new content while it is open
    hide()

Three events go back. `host.js` receives them and hands each to a function the
page registered: `onSurfaceInput({press, input})` takes the surface an input
landed on and one step of a drag in the page's coordinates, and the modal's
`(key, value)` goes to the function `overlay.show` was given. `onTheme(read)`
takes the function that reads the theme the page is drawn in.

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

| Operation | Wails, Go | Tauri, Rust + objc2 |
| --- | --- | --- |
| create a surface | `window.AddWebview` | `window.add_child` |
| move, resize, hide | `SetBounds`, `SetHidden` | `set_position`, `set_size`, `hide` |
| dim | `surfaceSetAlpha` | `native::alpha` |
| a modal's window | `window.Attach` | `WebviewWindowBuilder` + `parent_raw` |
| round the corners | `Mac.CornerRadius` | `native::corners` |
| identify a pressed view | `surfaceWatchMouse` + `hitTest:` | `native::watch_mouse` |
| a shape above the surfaces | `shapeCreate`, `shapeSetStyle` | `native::shape_*` |
| stop a webview painting white | `WebviewOptions.Transparent` | wry does it for every webview |
| record the window | `capture_darwin.go` | `capture.m` |
| serve the local pages | the app's own scheme | the app's own scheme |
| run a shell | `shell.go` | `shell.rs` |

Only macOS is written on either side. Windows and Linux are named in
`native_other.go` and `native.rs` and are not implemented.

One of those rows is not a public interface. A webview renders only the area it
has laid out and fills the rest with opaque white. No published interface turns
that off; `underPageBackgroundColor` is public but applies only past the end of a
page.

Both frameworks set a key by name for it, and both expose the intent rather than
the key: wry as a transparent webview, Wails as `WebviewOptions.Transparent` on a
webview added to a window. The Wails side is
[a fork](https://github.com/min-median-max/wails/tree/webview-in-window). Wails
v3 creates one webview per window and provides no method to add another, so every
surface here was previously a webview this example created itself: macOS only,
outside the application's asset server, and on its own message channel.

The fork adds `AddWebview`, which creates a webview from the window's
configuration, and `Attach`, which positions a window over a point in another
window's content. With both, a surface and a modal load from the application's
own scheme, import its runtime and receive its events, and this example creates
no webview itself. It also adds `Mac.TrafficLightPosition`, which places the
window's own buttons, and corrects the window's content size: Wails v3 made the
content rect one point smaller than the webview inside it, so the page received a
plane one point larger than the window at every size and the two hosts laid out
differently after a resize.

## What a plugin would be

**Wails.** A service, registered like `main.Surfaces` is today. It would export
`SyncSurfaces`, `SetShape`, `ClearShape`, `OverlayShow`, `OverlayPlace`,
`OverlayUpdate`, `OverlayHide`, `SetTheme` and `Report` for the main page, and
`Theme`, `ShellOpen`, `ShellWrite`, `ModalContent`, `ModalReady` and
`OverlayPick` for the pages a surface and a modal show; it would emit
`surface-pressed`, `surface-input`, `overlay-pick`, `theme`, `shell-output` and
`modal-content`. The shapes in `native_darwin.go` move with it. Nothing else
does: the webviews come from the framework.

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
