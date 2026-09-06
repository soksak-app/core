# Examples

Korean translation: [`README.ko.md`](README.ko.md).

## browser

`browser/` is the page. It runs on its own in a browser, where the surfaces are
simulated, and it is the page both applications below run.

The layout is the `soksak` library's. A sidebar, a rail and a terminal are
all the same card and differ only in role: whether it takes a share or a px
size, and whether the layout may move it. On top of that the page reproduces
the constraints of native compositing — a surface is above the CSS stack, and
the declared frame and the applied frame move separately, with a delay. What
passes here passes in an application.

The `+` button and the split buttons ask which plugin the new tab is for (T2).
Dragging a tab onto the middle of another card makes it a tab of that card (T3),
and onto an edge makes a place beside it (T4). When the source card has one tab
left, the card itself moves and no empty card is left behind (T5). The commit
delay in ⚙ 설정 makes V7a fail and the apply skew makes V7b fail. The check
results go to a log rather than the screen: the browser's console, and the
application's own log.

    pnpm example        # builds dist/ and serves the repository on :8749
                        # http://localhost:8749/examples/browser/index.html

One file per role, and the imports run one way:

    index.html      the document, and the wiring between the rest
    app.css         the tokens the chrome is drawn with, and the chrome's rules
    settings.js     what a person chooses, as one object. Announces; calls no one
    settings-ui.js  the ⚙ modal. Built when pressed, removed when closed
    icons.js        the lucide paths the chrome draws
    plugins/        what is registered — plugins and the sections they contribute
    projects.js     projects and the spaces inside them
    ids.js          issues prj- spc- tab-
    plane.js        one plane: cards, tabs, drag, rail, layer, render
    card.js         one card's header and body, and the tabs in it
    compositor.js   measures the slots the plane marks, and publishes
    verify.js       reads the plane and the compositor, and reports the result
    host.js         real native surfaces and modals, when an application holds
                    the page. Absent in a browser, where the page simulates them
    observe.js      presses one element when the observation component asks
    framework/      which runtime is holding this page, and how to speak to it
    terminal.html   the page a terminal surface shows
    overlay.html    the page a [data-native-modal] view shows

What crosses a boundary is announced, never called: settings announces a change
and the page re-lays the plane; the plane announces a render and the page
verifies and publishes; the compositor announces a commit and the page verifies.

### The model

    project  a root that is open. Holds spaces, a name and a colour
      └ space  one plane's worth: the arrangement, what was focused, the rail widths
          └ card  what Soksak arranges
              └ tab  a plugin and a title

A project is identified by its root, not by its id: opening a root that is
already open activates it. Switching a space exchanges the arrangement on the
one plane — Soksak.replace is the point that makes that one operation.

### Plugins and sidebars

A plugin has two things: a place in the `+` menu, and a surface. It does not own
a sidebar.

A section is one thing that can stand in a sidebar; a plugin file registers the
sections it contributes, and a file with no surface can contribute sections and
no plugin. A set is an ordered list of sections under an id. A link puts a set
in a place — left, or a plugin's rail or right — and a place with no link has no
sidebar. Sets and links are what a person composes, so they are in settings, and
⚙ 설정 is where they are edited.

A surface declares what it shows as `{url}` or `{page}`: an address anywhere, or a
document this host serves. The page publishes that with each commit, so nothing
outside the page names a kind of surface.

[`NATIVE-HOST.md`](NATIVE-HOST.md) is a draft: what the three host interfaces
are, what the two applications implement twice, and what publishing them as a
Wails service and a Tauri plugin would take.

## The applications

Each draws the surfaces with native views of its own. The page is shared and is
copied whole into each application's `frontend/`, together with `dist/`. Nothing
is rewritten and nothing is added per application: there is one `host.js`, one
`terminal.html` and one `overlay.html`, and the only thing that differs between
the two runtimes is how a page reaches its application.

`framework/` holds that difference, one file per runtime:

    framework/index.js      picks one and exports what the rest imports
    framework/tauriv2.js    invoke / listen, and Tauri's own document urls
    framework/wailsv3.js    the Wails bindings and its runtime
    framework/webview.js    no application: a plain browser, and no host

Each runtime is detected by what it defines: Tauri by `window.__TAURI__`, Wails
by the `wails:` scheme. A surface and a modal are documents of the same
application, loaded the same way, so the same detection applies.

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

### Watching what is drawn

The page cannot read what is composited: the surfaces and the modal are views
and windows the application creates, and the window server composites them.
Started with `--observe`, each application registers one more component, a
service on Wails and a plugin on Tauri, which prints the window server's number
for its window and for the windows attached to it:

    ./examples/wailsv3/bin/wailsv3 --observe
    ./examples/tauriv2/src-tauri/target/debug/soksak-tauri --observe

    observe: windows 5921

A capture tool addresses a window by that number, so it reads the composite
without raising the window and without moving the focus: `screencapture -l5921
out.png` on macOS, and `--capture` below reads the same window from inside the
application. A screen region would capture whatever is in front, and
raising the window changes the state being measured.

The first report is made when the page commits for the first time, which is when
the window is on screen and the surfaces exist. After that the number is printed
when the window set changes, not on a timer: the application attaches and
detaches the window itself, so it emits an event at that point and the component
subscribes.

A boundary lies over the surfaces, so a drag reaches it by coordinates. A button
in the page chrome is a DOM element, so `--click ms,selector` has the page
dispatch the click once the page has rendered:

    ./examples/wailsv3/bin/wailsv3 --observe --click '5000,button.act[title="설정"]'

    observe: clicked button.act[title="설정"]
    observe: windows 7480 7489

Nothing is reported while the window stands still, so `--drive` shakes a boundary
on its own, as `wait,x,y,dx,dy,ms,times` — wait that many ms for the pages to be
drawn, then press at x,y and sweep by dx,dy over ms, out and back, that many
times:

    ./examples/wailsv3/bin/wailsv3 --observe --drive 3000,404,294,-250,0,48,15

    observe: shaking (404,294) by -250,+0 in 3 steps, 15 times
    observe: shaking done

The press is held for the whole run. Releasing and pressing again fails once a
boundary stops at the minimum card size, because the next press lands where the
boundary no longer is.

Each step is delivered through `surface-input`, the same path a press on a
surface uses, so the measurement covers the product's own path. No key or button
is synthesised at the operating system, so the focus does not move.

`--capture <directory>` records the window while updates continue. The page
reports whether more updates follow, so a boundary dragged by hand is recorded
the same way as a driven one:

    ./examples/wailsv3/bin/wailsv3 --observe --capture /tmp/frames

    observe: wrote 249 frames to /tmp/frames

A window that is not being redrawn — the display is off, or the window is off
screen — still delivers frames, each marked idle and carrying no image. A
recording of no frames reports how many of those arrived.

Frames are written as they arrive, as raw BGRA behind a width, a height and a
row length. Encoding each frame would drop frames, and a dropped frame is the one
being measured. A screenshot cannot be used: the system returns a composite made
for each request, so a state that lasts one frame between a resize and the next
render is never captured.

`make examples-verify` runs both applications this way and reads the frames. See
`examples/test/`.

Only macOS is implemented for the window number. On Windows this would report
the HWND and on Linux the X window id. Without the flag neither component is
registered.

## What each one draws natively

A browser surface is a webview on google.com. A terminal surface is a webview on
a page this application serves, with a shell behind it. A `[data-native-modal]`
element is drawn by a webview of its own, above them.

Only macOS is written. `examples/wailsv3/native_other.go` and
`examples/tauriv2/src-tauri/src/native.rs` say what the other platforms would
use.
