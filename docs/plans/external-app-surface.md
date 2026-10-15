# External application surface

[한국어](external-app-surface.ko.md)

This proposal belongs to F194. It shows an application of another toolkit inside a surface without rewriting its interface as a plugin page.

## Problem

An application whose interface is written with another toolkit can be shown today only by rewriting that interface as a plugin page. A capture of its window adds the delay of the capture and loses the popups that the application opens as windows of their own.

## Approach

The application draws into a shared buffer that a sidecar hands to an image region, and it takes its input as events of its own toolkit. This generalizes the path of the terminal, where the vt sidecar draws into an IOSurface and the page forwards region input and DOM pointer events.

The work is in two sides that can each be discarded:

- **Side 1, the surface.** It names no application: an embed protocol and a client library, an application sidecar and an application plugin. When its gate fails, the branch and its repositories are discarded.
- **Side 2, the adapter of the example application** (a video editor written with Slint, licensed AGPL-3.0 with an exception for modules that reach it only through its interfaces). It depends only on the embed protocol and lives in its own repository under the license of the application. When its gate fails, only that repository is discarded.

Slint, egui and wgpu, Qt, and web interfaces are considered from the start. Side 2 implements the Slint adapter; the design review of side 1 checks that the protocol does not exclude the others.

## Scope

The surface shows an application that draws into the shared buffer: one whose toolkit lets the window render into a target that the application chooses (a Slint platform, an egui or wgpu texture, a Qt `QQuickRenderControl`), with the source to add an adapter. A web interface is shown in a document region. An application whose window the operating system composes and whose rendering target cannot be chosen, such as a native AppKit application, is not supported: macOS has no public interface that places a window or a view of another process inside a window, and a capture of its window with injected input adds the delay of the capture and loses its popups, so it does not meet the gate.

## What exists

- An image region shows a frame that its supplier sidecar hands to the host as `{"image":{name, generation, raster, token:{kind:"iosurface-global", id, nonce}, width, height, scale, format:"bgra8", sequence}}`; the host answers `image.consumed` and tells the supplier the size with `{"image":{"configure":{name, generation, raster, width, height, scale}}}` ([native surfaces](../spec/native-surfaces.md#image-regions)).
- An image region reports `key`, `insert`, `compose` and `focus` to its page. Pointer and wheel events pass through it to the page, and the page decides their meaning and the cursor.
- The terminal page forwards the region input as the sidecar request `input` and the DOM pointer events as `mouse`, `scroll` and `selection.*`.
- A sidecar speaks one JSON object per line on its standard input and output ([sidecars](../spec/sidecars.md)).

## Side 1

### Core

The first implementation does not change core: the application plugin forwards pointer, scroll and cursor through its page as the terminal does, and the size, scale and frame token use the existing image region path. Core changes only when the gate shows that the page path causes the delay; the candidates are a region input range that reports pointer events from the native view and a cursor rectangle, each specified first and tested Red and Green.

### Embed protocol and client library

- The sidecar starts the application with the path of a socket in its environment; the adapter in the application connects to it.
- The application receives the size and scale, the input (keys, input method composition and commit, pointer moves and buttons, scroll, focus) and the end.
- The application sends each frame token, the cursor shape, the caret of the input method and its state.
- The token of a shared buffer is defined for each operating system: darwin `iosurface-global`, windows a DXGI shared handle, linux a dmabuf. The host implements the darwin token; windows and linux wait for R2-7.
- The client library is toolkit-neutral (a Rust crate with a C interface): it creates the shared buffers (double or triple) and speaks the protocol.
- Menus, tooltips and drop-down lists are drawn by the application into the same buffer; Slint platforms, egui and `QQuickRenderControl` can draw them into one render target. Only system dialogs such as an open panel appear as windows of their own.

### Application sidecar and plugin

- The sidecar starts and stops the application, opens the embed socket, hands each frame token to the image region it supplies and passes the input that the page sends.
- The plugin shows one image region, forwards region input and DOM pointer and scroll events, and sets the cursor shape. When the application is a web address, it shows it in a document region instead.
- A test application draws a moving picture every frame and answers input at once, for the gate.

### Gate of side 1

On a real surface with the test application:

- frame gaps at 60 and 120 Hz have a p99 of at most two frames, with no missing frame;
- the delay from a pointer move to the present of its result has a median of at most 25 ms and a p90 of at most 40 ms on an idle machine;
- core is not changed, or the change stays within the region input range and the cursor and leaves the existing regions unchanged.

The delay is computed from the records of every step (native input, host relay, page, sidecar, application, present), so the step that causes it is named by a number.

## Side 2

- The adapter selects a Slint platform that draws into the shared buffer and turns embed input into window events (pointer, keys, input method preedit and commit, scroll, scale); the cursor that the application sets is sent as an embed message.
- The change to the application is confined to the selection of its window platform. When editing code would have to change, side 2 stops.
- No other repository links the code of this repository; the application is reached only through the embed protocol. The name and the mark of the application are not used.
- Gate: the application opens a project, plays and edits on the surface, and meets the gate of side 1 while it plays.

## Connector plugins

An application reaches people through a connector plugin, which [connector plugins](connector-plugins.md) defines.

## Repositories

The new repositories (the embed kit, the application sidecar, the application plugin and the adapter) start as local repositories, at version 0.0.1. Their remotes and registry entries are created after their gate passes, so a discarded side leaves nothing published.

## Order

1. F194 and its sub-items in the checklist, on the branch `feat/app-surface-F194`.
2. The embed protocol, the client library and the test application (F194.1); then the sidecar and the plugin (F194.2); each unit tested Red and Green.
3. The gate of side 1 (F194.3). It passes, or side 1 is discarded with its result recorded.
4. Side 2 (F194.4) and its gate.
5. Only a side that passed is merged.
