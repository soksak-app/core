# Examples

## browser

`browser/` is the page. It runs on its own in a browser, where the surfaces are
simulated, and it is the page both applications below run.

    pnpm example        # builds dist/ and serves the repository on :8749
                        # http://localhost:8749/examples/browser/index.html

One file per role, and the imports run one way:

    index.html      the document, and the wiring between the rest
    settings.js     what a person chooses, as one object. Announces; calls no one
    settings-ui.js  the ⚙ modal. Built when pressed, removed when closed
    icons.js        the lucide paths the chrome draws
    plugins/        what is registered — plugins and the sections they contribute
    projects.js     projects and the spaces inside them
    ids.js          issues prj- spc- tab-
    plane.js        one plane: cards, tabs, drag, rail, layer, render
    compositor.js   measures the slots the plane marks, and publishes
    verify.js       reads the plane and the compositor. Nothing reads it
    host.js         real native surfaces and modals, when an application holds
                    the page. Absent in a browser, where the page simulates them
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

A surface says what it shows as `{url}` or `{page}`: an address anywhere, or a
document this host serves. The page publishes that with each commit, so nothing
outside the page names a kind of surface.

## The applications

Each draws the surfaces with native views of its own. The page is shared and is
copied whole into each application's `frontend/`, together with `dist/`. Nothing
is rewritten and nothing is added per application: there is one `host.js`, one
`terminal.html` and one `overlay.html`, and the only thing that differs between
the two runtimes is how a page reaches its application.

`framework/` holds that difference, one file per runtime:

    framework/index.js      picks one and exports what the rest imports
    framework/tauriv2.js    invoke / listen, and Tauri's own document urls
    framework/wailsv3.js    the Wails bindings and its loopback server
    framework/webview.js    no application: a plain browser, and no host

A runtime says it is there — Tauri by `window.__TAURI__`, Wails by the
`wails:` scheme its window opens — and the page picks the first that does.
Pages an application serves are loaded from its own loopback address, which says
nothing about which application it is, so those urls carry `framework=<name>`
and the page reads it instead of guessing.

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
