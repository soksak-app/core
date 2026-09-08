# Native host interfaces

[한국어](native-host.ko.md)

The example page uses the interfaces exported by [host.js](../../examples/browser/host.js). `framework/` supplies runtime calls, events, and document URLs. In a plain browser, `native` is false, `chrome` is null, and native drawing operations do nothing.

| Interface | Operations | Responsibility |
| --- | --- | --- |
| `surfaces` | `kinds`, `report`, `theme`, `place` | Native surface creation, preparation, presentation, visibility, and dimming |
| `shapes` | `set`, `clear` | Native outlines above surfaces |
| `chrome` | `draggable`, `controls` | Main-window dragging and actual native button geometry |
| `overlay` | `show`, `place`, `update`, `hide` | The marked DOM element in a native webview |

`surfaces.place(record)` returns the host's placement promise. An undrawn record requests `syncSurfaces`; a drawn record also requests `presentSurfaces`. The page waits for presentation before preparing the latest pending layout. Each preparation returns one `ticket` and a `placements` array for the complete layout. Tickets are local to the owning window. The [surface specification](native-surfaces.md) defines placement and presentation.

`onSurfaceInput({press, input})` receives a surface press and drag phases in main-page coordinates. An overlay's `(key, value)` response reaches the callback registered by its owner. [Native modals](native-modals.md) defines required attributes, frame coordinates, and content updates.

## Project and settings operations

`projects.js`, `library.js`, and `storage.js` use the runtime bridge for `projectFolder`, `projectCreate`, `folderChoose`, `projectOpen`, `projectRelease`, `windowNew`, `windowState`, `windowReady`, `windowClose`, and `workspace`. `folderChoose` uses the host’s public directory dialog API; cancellation returns no path. `projectCreate` creates a new directory and returns its canonical identity. `windowNew` creates an unassigned application window. Workspace snapshots include the project IDs owned by open windows. The [project specification](projects.md) defines their file storage and window behavior. Wails selects native state from the calling window supplied by the framework's service context. Tauri selects it from the command's window. Events, surfaces, overlays, input monitors, and shells belong to that window. Surface and modal labels are unique across windows. Input monitors and shells are removed when their window closes.

## macOS implementation

Wails uses application-owned additional `WKWebView` instances. Tauri uses its child-webview API. Both place those views inside their owning project `NSWindow`; settings and menus create no additional OS window. Framework dependencies are unchanged by the current surface and backdrop changes.

Shared AppKit code manages native button layout, input selection, and the surface layout transaction. The input code uses hit testing and `_setIgnoresMouseMoveEvents:` so pointer tracking reaches the visible webview. This does not change delayed cursor responses. Surface presentation commits the layer transaction after `_doAfterNextPresentationUpdate:` completes for the main document and visible application documents. It does not wait for external documents or block the UI thread. Settings and menus use transparent webview backgrounds; ordinary surfaces use opaque rendering. Shared CSS defines modal shading and blur.

Wails completes its initial webview size correction before applying saved window geometry. Its frame-size and position getters and setters then use matching coordinates.

The window-controls container repositions buttons when AppKit reparents them during recording. Position queries only read geometry. Fullscreen transitions temporarily restore the buttons to their standard title-bar container.

Windows and Linux native-host behavior is unverified. Wails additional-webview creation is currently implemented only on macOS. [Feature status](../features.md) records validation and release separately.
