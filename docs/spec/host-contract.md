# Host contract cases

[한국어](host-contract.ko.md)

The Wails host (Go) and the Tauri host (Rust) implement one host contract ([native hosts](hosts.md)). This document lists the contract cases that both hosts must execute, so that a behavior tested in one host is tested in the other.

## Declaration

Each host test function declares the cases it executes on a line directly above the function, or above its test attributes in Rust:

```go
// contract: endpoint.transport.invalid-json-closes
func TestEndpointClosesOnInvalidJSON(t *testing.T) {
```

```rust
// contract: endpoint.transport.invalid-json-closes
#[test]
fn invalid_json_closes_connection() {
```

A test function may declare several cases, separated by commas. Every test function in `packages/host/wailsv3/tests/`, `packages/host/wailsv3/src/*_test.go`, `packages/host/tauriv2/tests/`, and the test modules in `packages/host/tauriv2/src/` declares at least one case. A test declares a case only when its assertions check the case's outcome.

## Check

`make host-contract-check` runs each host's tests in the default configuration and in the diagnostics configuration (Go tag `diagnostics`, Rust feature `diagnostics`) through the command supervisor and reads the reported results. It fails when:

- a case in scope for a host has no passing test in that host;
- a declared test ran in no configuration, or failed or was skipped in one;
- a test declares no case, an undefined case, or a case outside its host's scope;
- a declaration is not attached to a test function;
- a host run reports zero tests.

The scope column is `both`, or `<host> only: <reason>` for behavior that exists in one host. The check runs on macOS, the only platform that both hosts implement; Windows and Linux entry points return `not implemented` errors and have no cases. The unit tests of the check (`scripts/test/check-host-contract.test.mjs`) inject each failure and run in `pnpm test`.

## Application menu

Both hosts build the application menu from one table, so a menu item present on one host and absent on the other is a defect. The `title` items take their titles from the selected language; `system` items keep the framework-provided title (the bundle declares the table's languages as localizations, so system-managed titles follow the same language). Keys use the `host.menu` report format. The supported languages are the table's language columns — `ko` and `en` today, extended by adding a column together with the workbench language declaration. The language is the 일반 setting `language`: `auto` follows the system language's primary tag matched against the supported set, and an unsupported system language falls back to the default language `en`; the page pushes the effective language to the host (`set_menu_language`) before first use and on every change, and before that push the host builds the menu from the system language with the same matching and fallback.

Menus:

| id | ko | en |
|---|---|---|
| app | (the application name) | (the application name) |
| file | 파일 | File |
| edit | 편집 | Edit |
| view | 보기 | View |
| window | 윈도우 | Window |
| help | 도움말 | Help |

Items:

| menu | id | source | ko | en | key |
|---|---|---|---|---|---|
| app | about | title | 정보 | About | |
| app | services | system | | | |
| app | hide | title | 가리기 | Hide | cmd+h |
| app | hide-others | title | 기타 가리기 | Hide Others | opt+cmd+h |
| app | show-all | title | 모두 보이기 | Show All | |
| app | quit | title | 종료 | Quit | cmd+q |
| file | close-window | title | 윈도우 닫기 | Close Window | cmd+w |
| file | close-all | system | | | |
| edit | undo | title | 실행 취소 | Undo | cmd+z |
| edit | redo | title | 다시 실행 | Redo | shift+cmd+z |
| edit | cut | title | 잘라내기 | Cut | cmd+x |
| edit | copy | title | 복사 | Copy | cmd+c |
| edit | paste | title | 붙여넣기 | Paste | cmd+v |
| edit | select-all | title | 모두 선택 | Select All | cmd+a |
| view | text-larger | title | 글자 크게 | Bigger Text | cmd+= |
| view | text-smaller | title | 글자 작게 | Smaller Text | cmd+- |
| view | text-default | title | 글자 기본 크기 | Default Text Size | cmd+0 |
| view | fullscreen | system | | | |
| window | new-window | title | 새 창 | New Window | shift+cmd+n |
| window | bring-all-to-front | system | | | |

`host.menu` reports `{language, menus}` — the active menu language and the built menus; the language is the host's own state, never inferred from titles. Its per-host comparison and the table above are checked at the window tier, and `scripts/check-host-parity.mjs` checks that both hosts carry this same table in their menu builders.

## Contract cases

| Case | Behavior | Scope |
| --- | --- | --- |
| `authorization.surface.cross-surface-rejected` | A caller from one surface acting on another surface is rejected. | both |
| `authorization.surface.own-surface-accepted` | A caller acting on its own surface is accepted. | both |
| `authorization.surface.unscoped-caller-rejected-for-document` | A document request from a caller without a surface that targets a surface is rejected. | both |
| `authorization.main.known-main-caller-accepted` | A caller without a surface whose id is the main window's id is accepted for a surface target. | both |
| `authorization.main.unknown-main-caller-rejected` | A caller without a surface whose id is not the main window's id is rejected. | both |
| `clipboard.persist-png.writes-exact-bytes` | Saving a valid PNG payload returns a path whose file holds exactly the input bytes. | both |
| `clipboard.persist-png.owner-only-mode` | The saved PNG file has mode 0600. | both |
| `clipboard.png.rejects-oversize` | A PNG payload larger than 16 MiB is rejected. | both |
| `clipboard.png.rejects-empty` | An empty PNG payload is rejected. | both |
| `clipboard.png.accepts-valid-within-bound` | A payload within the bound that starts with the PNG signature and a valid `IHDR` chunk is accepted. | both |
| `clipboard.png.rejects-bad-signature` | A payload that does not start with the 8-byte PNG signature is rejected with an error that names the PNG signature. | both |
| `clipboard.png.rejects-bad-header` | A payload whose first chunk is not a 13-byte `IHDR` chunk with a matching CRC, a nonzero width and height, a bit depth and color type pair that PNG allows, compression and filter method 0, and interlace method 0 or 1 is rejected with an error that names the PNG header. | both |
| `clipboard.read.requires-user-initiated` | A clipboard read that is not an explicit user paste is rejected. | both |
| `clipboard.read.rejects-unknown-type` | A user-initiated clipboard read of an unknown type is rejected. | both |
| `clipboard.read.accepts-known-types` | User-initiated reads of text and file URLs are accepted. | both |
| `links.open.accepts-web-and-mail-schemes` | Absolute `http`, `https`, and `mailto` URLs are accepted for opening. | both |
| `links.open.rejects-other-schemes` | A URL with another scheme, a URL that does not parse, and a URL longer than 8192 characters are rejected. | both |
| `notifications.request.accepts-tab-notices` | A notification with a surface and title of 1 to 256 characters and a body of 1 to 1024 characters without control characters is accepted, and a removal needs only the surface. | both |
| `notifications.request.rejects-invalid-fields` | An empty, too long, or control-character surface, title, or body is rejected with an error that names the field. | both |
| `diagnostics.capture-stop.payload-reports-frame-limit` | The capture stop payload of a limited capture reports frames, count, limited true, and the longest gap. | both |
| `diagnostics.capture-stop.payload-reports-unbounded` | The capture stop payload of a capture below its limit reports limited false. | both |
| `diagnostics.capture-stop.payload-reports-layout-timeline` | The capture stop payload always reports a `layouts` array, also when no layout transaction was recorded. | both |
| `diagnostics.capture-stop.payload-preserves-layout-stages` | Each `layouts` entry keeps the recorded ticket, begun, presented and committed values. | both |
| `diagnostics.native-objects.payload-names-counts` | The `diagnostics.native.objects` reply names the library's live counts as `windowCompositions`, `surfaceHosts`, and `inputRegistrations`, each an integer, and nothing else. | both |
| `diagnostics.native-objects.equal-validates` | `diagnostics.native.objects` accepts `equal` only as an object of exactly `windowCompositions`, `surfaceHosts`, and `inputRegistrations`, each a non-negative integer, and rejects any other value with `equal must be an object of windowCompositions, surfaceHosts and inputRegistrations, each a non-negative integer`; counts that do not reach `equal` fail with `window object counts did not reach <equal> within 10s; they are <counts>`, each written as `windowCompositions N, surfaceHosts N, inputRegistrations N`. | both |
| `diagnostics.process-exit.pid-validates` | `diagnostics.process.exit` accepts `pid` only as an integer from 1 to 2147483647 and rejects a missing or other value with `pid must be a positive integer`. | both |
| `documents.request.accepts-own-surface` | A document request for the caller's own surface is accepted and returns the surface and name key. | both |
| `documents.request.rejects-foreign-or-missing-caller` | A document request from no caller surface or from another surface fails with "not surface". | both |
| `documents.request.rejects-invalid-names` | Empty, capitalized, hyphen-first, slash-containing, and 65-character document names are rejected. | both |
| `documents.request.zoom-must-be-finite-positive` | A document zoom request without a zoom, or with zero or a negative zoom, is rejected; a finite positive zoom is the factor. | both |
| `documents.request.entry-requires-offset` | A document `go` request with `entry` requires a non-zero integer `offset`, and another action with an `offset` is rejected. | both |
| `documents.commit.precedes-messages` | A message that a webview sends after its document commits is handled after the commit, commits of one webview are handled in order, and another webview's messages do not wait. | wailsv3 only: Wails receives WebKit's commit and script messages on the main thread and runs each handler in its own goroutine, while Tauri does not reset the document state of a surface on a commit |
| `documents.request.ignores-placement-fields` | Parsing a document request keeps only the surface and document and drops placement fields. | both |
| `documents.request.url-and-action-default-empty` | A parsed document request without url or action has both empty. | both |
| `documents.registry.rejects-duplicate-reservation` | Reserving a document key twice fails with "already attached". | both |
| `documents.registry.reserved-name-is-not-attached` | Reading a reserved document key before it is set fails. | both |
| `documents.registry.set-attaches-reserved-name` | Setting a reserved document key succeeds and reading returns the handle. | both |
| `documents.registry.lists-names-by-handle` | The registry lists each document handle with its key. | both |
| `documents.registry.surface-close-removes-only-its-documents` | Removing a surface returns its documents, makes their keys unreadable, and keeps another surface's documents. | both |
| `documents.registry.rejects-set-after-surface-removed` | Setting a document key whose surface was removed fails. | both |
| `documents.registry.remove-reserved-returns-empty` | Removing a reserved but unset document name succeeds with an empty handle. | both |
| `documents.registry.remove-attached-returns-handle-once` | Removing an attached document name returns its handle, and removing it again fails. | both |
| `host.arguments.declared-only` | `--config-dir PATH` and `--config-dir=PATH` set the configuration directory; an undeclared argument, a flag without a value and a repeated flag fail with their texts. | both |
| `host.arguments.registry-ca-in-diagnostic-builds` | A diagnostic build accepts `--registry-ca PATH`, and its registry fetches then trust only the authorities of that PEM file; a file without a certificate fails with `--registry-ca <path>: <reason>`. | both |
| `endpoint.process.rejects-a-malformed-lock` | A `process.lock` whose contents are not a positive process ID, including `0`, refuses the endpoint with `<path>: invalid process lock` and stays in place. | both |
| `endpoint.process.one-owner-per-config-dir` | A second endpoint on the same configuration directory is refused with "already owned by process", and the first keeps its lock until it closes. | both |
| `endpoint.transport.http-request-line-closes` | An HTTP request line closes the connection without a reply or a method call. | both |
| `endpoint.transport.invalid-json-closes` | A frame whose body is not JSON closes the connection without a reply. | both |
| `endpoint.transport.closing-a-disconnected-connection-succeeds` | Closing a connection whose socket is already disconnected succeeds; other shutdown errors are reported. | tauriv2 only: the Rust host shuts the socket down explicitly, which reports a disconnected socket, while Go closes the connection without a shutdown |
| `endpoint.transport.non-jsonrpc-object-closes` | A JSON frame that is not a JSON-RPC 2.0 request closes the connection without a reply. | both |
| `endpoint.transport.undeclared-method-closes` | An undeclared method closes the connection without a reply, and nothing reaches the page. | both |
| `endpoint.diagnostics.methods-exist-only-in-diagnostic-builds` | In a release build diagnostics.transcript closes the connection and reaches no page; in a diagnostic build it is answered. | both |
| `endpoint.rpc.round-trip-by-id` | Several requests on one connection each receive a JSON-RPC 2.0 reply with the matching id and result. | both |
| `endpoint.rpc.page-params-omit-window` | The page receives forwarded params without the window field. | both |
| `endpoint.rpc.unknown-window-1003` | A declared method on a window that does not exist returns error 1003 without reaching the page. | both |
| `endpoint.rpc.missing-window-param-invalid` | A status.get without a window param returns -32602. | both |
| `endpoint.names.unknown-host-name-1001` | command.run with an unknown host name returns error 1001. | both |
| `endpoint.names.missing-name-invalid` | status.get without a name returns -32602. | both |
| `endpoint.names.owner-form-required` | Names without the owner.name form, and non-string names, return -32602. | both |
| `endpoint.names.valid-name-examples` | Names such as core.surface.document and plugin-x.a-1 are valid. | both |
| `endpoint.input.pointer-invalid-phase` | A pointer input with an unknown phase returns -32602. | both |
| `endpoint.input.pointer-missing-coordinate` | A pointer input without x returns -32602. | both |
| `endpoint.input.pointer-numeric-button-rejected` | A numeric pointer button returns -32602. | both |
| `endpoint.input.pointer-middle-button-rejected` | The middle pointer button returns -32602. | both |
| `endpoint.input.pointer-activate-only-on-move` | activate is rejected with the down phase and accepted with the move phase. | both |
| `endpoint.input.pointer-activate-must-be-bool` | A non-boolean activate returns -32602. | both |
| `endpoint.input.pointer-defaults` | A pointer input without button or activate uses the left button and no activation. | both |
| `endpoint.input.pointer-right-button-accepted` | The right pointer button is accepted and passed as the right button. | both |
| `endpoint.input.pointer-phase-and-scroll-decoding` | The drag and scroll phases, deltaY, and fractional coordinates are passed through. | both |
| `endpoint.input.key-unknown-modifier-rejected` | An unknown key modifier returns -32602. | both |
| `endpoint.input.key-shift-command-mask` | The shift and command modifiers become the bit mask 9, with the key and phase passed through. | both |
| `endpoint.input.key-control-option-and-text` | The control and option modifiers become 6, and text is passed through. | both |
| `endpoint.input.key-invalid-phase-or-modifier-type` | An unknown key phase or a non-array modifiers value returns -32602. | both |
| `endpoint.discovery.writes-endpoint-json` | endpoint.json holds the transport, address, pid, application, version, executable, and start time. | both |
| `endpoint.discovery.written-after-first-window` | endpoint.json is not written when the endpoint starts; publishing it for a window that does not exist fails and writes no file; after publishing for an existing window, a request for that window is answered. | both |
| `endpoint.discovery.endpoint-json-mode-0600` | endpoint.json has mode 0600. | both |
| `endpoint.discovery.removes-endpoint-json-on-close` | endpoint.json is removed when the endpoint closes. | both |
| `endpoint.discovery.removes-socket-on-close` | The socket exists while serving and is removed when the endpoint closes. | both |
| `endpoint.discovery.close-keeps-replacement` | Closing does not remove an endpoint.json that another process wrote. | both |
| `endpoint.socket.private-modes` | The socket directory has mode 0700 and the socket has mode 0600. | both |
| `endpoint.socket.sweeps-ended-process-sockets` | Listening removes this application's sockets of ended processes and keeps live and other applications' sockets. | both |
| `endpoint.socket.refuses-open-directory` | A socket directory open to others is refused with its mode in the error. | both |
| `endpoint.socket.refuses-foreign-owner` | A socket directory owned by another user is refused with "belongs to another user". | both |
| `endpoint.socket.refuses-non-directory` | A socket path that is a symbolic link is refused with "is not a directory". | both |
| `endpoint.watch.notifies-watching-connection` | After status.watch, a change reaches that connection as a status.changed notification with window, name, and value. | both |
| `endpoint.watch.non-watching-connection-not-notified` | A connection that does not watch receives no notification. | both |
| `endpoint.watch.unwatch-is-per-connection` | An unwatch on one connection keeps the notifications of another connection that watches the same status. | both |
| `endpoint.watch.page-watch-deduplicated` | A second connection watching the same status sends no additional status.watch to the page. | both |
| `endpoint.watch.no-page-unwatch-while-watched` | The page receives no status.unwatch while any connection still watches the status. | both |
| `endpoint.watch.last-watcher-close-unwatches-page` | Closing the last watching connection sends status.unwatch to the page. | both |
| `endpoint.watch.registry-reflects-watches` | The watch registry lists exactly the active watches and is empty after the last watcher leaves. | both |
| `endpoint.watch.surface-and-plain-forwarded-separately` | A surface watch and a plain watch on the same name are both forwarded to the page with their own params. | both |
| `endpoint.watch.empty-surface-invalid` | status.watch with an empty surface returns -32602. | both |
| `endpoint.watch.surface-change-names-surface` | A surface watch change carries the surface; a plain watch change does not. | both |
| `endpoint.watch.surface-unwatch-forwarded-with-surface` | Unwatching a surface watch sends status.unwatch with the surface to the page. | both |
| `endpoint.watch.surface-unwatch-keeps-plain-watch` | Unwatching a surface watch keeps the plain watch on the same name. | both |
| `endpoint.watch.subscription-arrival-order` | watch, unwatch, and watch sent back to back reach a slow page in that order, and the connection keeps watching. | both |
| `endpoint.watch.other-requests-not-blocked-by-pending-subscription` | A later request on the same connection is answered while a page unwatch is still pending. | both |
| `exposure-reply.payload.main-reply-unscoped` | A main document reply payload without a surface decodes with an empty surface. | both |
| `exposure-reply.payload.scoped-reply-keeps-surface` | A reply payload with a surface keeps it through encoding and decoding. | both |
| `exposure-reply.target.main-and-surface-distinct` | A reply without a surface targets the window's main document, and a reply with a surface targets that surface document. | both |
| `exposure-reply.target.invalid-surface-rejected` | A reply whose surface is null, empty, a number, or an object is an error, not a main reply. | both |
| `exposure.list.appends-host-entries-registered` | The exposure list keeps the page's entries and adds the host status and command entries as registered. | both |
| `exposure.list.host-entries-exact-sorted-set` | The host status and command names equal an exact sorted list. | both |
| `exposure.list.host-entries-described` | Every host entry has a non-empty description. | both |
| `exposure.list.host-quit-result-null` | host.quit declares a null result schema. | both |
| `exposure.list.non-object-list-rejected` | A page exposure list that is not an object is an error. | both |
| `exposure.timeout.command-run-default-and-declared` | command.run waits 10 s by default and uses a declared timeout. | both |
| `exposure.timeout.status-next-unbounded` | status.next without a timeout has no time limit. | both |
| `exposure.timeout.invalid-timeout-rejected` | A command.run timeout of 0, above 600000, fractional, a string, or negative returns -32602. | both |
| `exposure.timeout.status-next-timeout-rejected` | status.next with any timeout returns -32602. | both |
| `exposure.relay.reply-resolves-request` | A reply from the target document with a matching id resolves the request with its result. | both |
| `exposure.relay.keeps-value-text` | A page reply is relayed as the text the page sent, so the keys of a value keep their order (`{"zeta":1,"alpha":{"b":2,"a":1}}` stays as sent). | both |
| `exposure.relay.missing-result-is-null` | A reply without a result resolves to null. | both |
| `exposure.relay.error-reply-keeps-code-and-message` | An error reply fails the request with the same code and message. | both |
| `exposure.relay.foreign-document-reply-ignored-timeout-1005` | A reply from another document is ignored, the request times out with 1005, and a late reply is not accepted. | both |
| `exposure.relay.send-failure-1003` | A failed send to the document fails the request at once with 1003. | both |
| `exposure.relay.closed-document-fails-pending-1003` | Closing a document fails its pending requests with 1003. | both |
| `exposure.relay.no-timeout-waits-until-close` | A request without a timeout waits until the document closes and then fails with 1003. | both |
| `exposure.window.dropped-view-work-reports-no-view` | Work sent to a webview that is destroyed before it runs yields no result instead of a receive error, so `host.window` reports a closing modal without its view; work that runs and fails keeps its error. | tauriv2 only: Tauri runs webview work through a dispatch that drops the work when the webview is destroyed, while Wails reads the modal view from its own record |
| `exposure.windows.closing-window-omitted` | `host.windows` leaves out a window whose close was accepted, without querying it. | tauriv2 only: Tauri asks its runtime for the title and focus of each window, which fails after a close removed the window from the runtime and before the Destroyed event unregisters it; Wails reads the title from host state and its focus query returns no error |
| `exposure.windows.open-window-query-failure-reported` | A failed title or focus query of an open window fails `host.windows` with that error. | tauriv2 only: Tauri asks its runtime for the title and focus of each window, which fails after a close removed the window from the runtime and before the Destroyed event unregisters it; Wails reads the title from host state and its focus query returns no error |
| `exposure.windows.entry-fields` | A listed window carries `ready`, `window`, `title`, `project` (null without a project) and `key`. | tauriv2 only: Tauri asks its runtime for the title and focus of each window, which fails after a close removed the window from the runtime and before the Destroyed event unregisters it; Wails reads the title from host state and its focus query returns no error |
| `flush.queue.rejects-send-when-full` | A send fails when the write queue is full because the sidecar does not read. | both |
| `flush.queue.full-error-says-not-keeping-up` | The full-queue error says "is not keeping up". | both |
| `flush.buffer.replies-delivered-after-drain` | Replies buffered while the queue is full reach the sidecar after it reads again. | both |
| `flush.buffer.closes-delivered-after-drain` | Surface close notices buffered while the queue is full reach the sidecar. | both |
| `flush.buffer.consumed-acks-not-coalesced` | Each buffered consumed acknowledgement arrives once, including two for the same image. | both |
| `flush.buffer.delivered-after-queued-bodies` | Buffered replies and close notices arrive after the bodies already queued. | both |
| `images.invalidate.sidecar-connection-loss-resends-configure` | Invalidating a sidecar's images re-sends its configure at the same size and leaves other sidecars' images untouched. | both |
| `performance.trace.enable-writes-log-and-sidecar-flags` | Enabling the trace creates the log file and writes the log-path flag into every existing service directory. | both |
| `performance.trace.disable-removes-flags-keeps-log` | Disabling the trace removes the sidecar flags and keeps the log file. | both |
| `performance.trace.relay-requires-object-with-event` | A relayed page line must be an object with an event; rejected lines append nothing. | both |
| `performance.trace.enable-without-services` | The enabled host accepts page events before any service exists. | both |
| `performance.trace.already-off-writes-nothing` | Disabling an already disabled trace does not create or append output. | both |
| `performance.trace.relay-records-writer-pid` | A relayed page line records the host process that writes it as `pid`. | both |
| `performance.trace.rotates-at-10mb` | A host line appended to an output of 10 MB or more first moves that output to `performance.ndjson.1` and starts a new one. | both |
| `performance.sampler.failed-reading-is-explicit` | A sampler reading that cannot obtain a resident size records `error` instead of `rss_host_kb`. | both |
| `performance.clock.before-epoch-is-explicit` | A trace timestamp before the Unix epoch is an error, not the epoch. | tauriv2 only: the Rust host formats timestamps from a duration since the epoch, which fails before it, while Go formats any time |
| `performance.trace.switch-and-relay-report-filesystem-errors` | Switch and relay requests return directory, flag, and output failures. | both |
| `performance.trace.invalid-switch-and-cleanup-errors` | Invalid switch reads and invalid flag directories are errors; cleanup preserves the invalid directory. | both |
| `performance.trace.derive-service-flags-and-reset` | New services receive the host switch; reset and disabled reattachment remove stale flags, and disabled observation does not format events. | both |
| `log.open.rotates-at-10mb` | Opening a log file of 10 MB or more first moves it to `<name>.1`, replacing the previous generation, and starts a new file. | both |
| `log.open.appends-below-bound` | Opening a smaller log file appends to it, and a new log file has mode 0600. | both |
| `log.application.start-replaces-standard-error` | Starting the application log writes the run's start line and makes the file the standard error of the process and of the children it starts. | both |
| `log.service.standard-error-goes-to-service-log` | A persistent service started by the host writes its standard error to `logs/<executable-name>.log`. | both |
| `log.service.open-failure-fails-start` | A service log that cannot open fails the start with `sidecar <name>: service log: <error>` and the service does not start. | both |
| `images.envelope.rejects-unattached-image` | An envelope for an image name that was never attached is answered with notAttached. | both |
| `images.envelope.refusal-echoes-name-and-sequence` | A refusal carries the name and sequence of the envelope. | both |
| `images.envelope.refusal-preserves-quoted-name` | A refusal for a name containing a quote is valid JSON and keeps the name. | both |
| `images.envelope.rejects-other-sidecar` | An envelope for an attached image from another sidecar is answered with notAttached. | both |
| `images.envelope.presents-attached-current-frame` | A frame of the current raster from the attaching sidecar is presented with its token, size, name, and sequence. | both |
| `images.envelope.present-carries-nonce-scale-generation-raster` | A presented frame also carries the nonce, scale, generation, and raster. | both |
| `images.envelope.rejects-unsupported-format` | An envelope with a format other than bgra8 is answered with unsupported. | both |
| `images.envelope.rejects-bad-nonce-length` | An envelope whose nonce is not 16 bytes is answered with unsupported. | both |
| `images.envelope.rejects-unknown-token-kind` | An envelope whose token kind is not iosurface-global is answered with unsupported. | both |
| `images.envelope.ignores-body-without-image` | A JSON body without an image field is not an image envelope. | both |
| `images.envelope.ignores-invalid-json` | A body that is not JSON is not an image envelope. | both |
| `images.ack.consumed-carries-frame-identity` | A successful presentation is acknowledged with consumed and the frame name, generation, raster, and sequence. | both |
| `images.ack.failure-carries-error-and-frame-identity` | A failed presentation is answered with the error and the frame name, generation, raster, and sequence. | both |
| `images.transfer.rejects-duplicate-sequence` | Repeating a sequence on the current raster is answered with stale. | both |
| `images.transfer.reconfigure-advances-raster` | Configuring a new size returns a larger raster number. | both |
| `images.transfer.rejects-stale-raster` | A frame for a superseded raster is answered with stale, and a frame for the new raster is presented. | both |
| `images.transfer.configure-stamps-current-generation` | A raster configuration carries the current surface generation. | both |
| `images.transfer.generation-advances` | A later generation has a larger number. | both |
| `images.transfer.rejects-old-generation-after-reattach` | After the image is attached again in a new generation, a frame of the old generation is answered with notAttached. | both |
| `images.transfer.reattach-continues-raster` | An image detached and attached again in the same generation continues its raster revision above the last one it had, so its next configuration is newer than any configuration the sidecar received; a new generation starts the count again. | both |
| `images.transfer.new-generation-invalidates-queued-old-frame` | Beginning a new generation before the image closes makes a queued old-generation frame answer notAttached. | both |
| `images.wait.blocks-before-first-frame` | The presentation wait does not pass before the first frame of a visible raster. | both |
| `images.wait.releases-after-current-frame-presented` | The presentation wait passes once a frame of the current raster is presented. | both |
| `images.wait.successful-handle-replies-consumed` | Handling an envelope whose main-thread presentation succeeds replies consumed. | both |
| `images.wait.newer-sequence-rearms-wait` | Deciding a newer sequence on the same raster makes the presentation wait block again. | both |
| `images.wait.reconfigure-clears-presented` | Reconfiguring the raster clears the presented state. | both |
| `images.wait.hidden-image-does-not-block` | A hidden image does not block the presentation wait, and showing it blocks again. | both |
| `images.wait.hidden-surface-does-not-block` | A hidden surface does not block the presentation wait, and showing it blocks again. | both |
| `images.wait.ended-generation-does-not-block` | Ending the surface generation releases the presentation wait. | both |
| `images.visibility.survives-first-document-navigation` | A surface hidden before its first document navigation stays hidden afterwards. | both |
| `images.visibility.hidden-surface-defers-configuration` | Configuring an image of a hidden surface returns no configuration until the surface is shown. | both |
| `images.visibility.shown-surface-reconfigures-its-raster` | A surface shown again after it was hidden configures a new raster revision even at the same size, so the presentation barrier does not wait for frames of the hidden period. | both |
| `images.visibility.refresh-list-excludes-hidden` | The refresh list leaves out images of hidden surfaces and hidden images. | both |
| `images.present.rejects-frame-superseded-during-main-thread` | A frame whose raster is reconfigured before main-thread presentation is answered with stale. | both |
| `images.present.rejects-frame-detached-during-main-thread` | A frame whose surface images are removed before main-thread presentation is answered with stale. | both |
| `images.present.main-thread-failure-reports-present-failed` | A failed main-thread presentation is answered with presentFailed, and the presentation wait returns that error. | both |
| `images.present.missing-native-surface-requests-reconfiguration` | A presentation that fails with notFound requests a fresh configuration of the same raster. | both |
| `images.attach.surface-close-removes-only-its-images` | Removing a surface returns its image handles and keeps another surface's images. | both |
| `images.attach.rejects-reservation-without-sidecar` | An image reservation without its owning sidecar is rejected and registers nothing. | both |
| `images.present.replaced-frame-is-logged-as-invalidated` | A frame that is no longer current (`stale`, `notAttached`, or `staleRaster native=... frame=...`) answers `stale` and logs `image frame invalidated before native presentation: ... reason=<detail>` without marking a presentation failure. | both |
| `images.present.failure-line-names-the-current-frame` | Another presentation failure answers its reason (`presentFailed` for an unknown detail) and logs `image present on main thread error: ... reason=<detail> current <frame state>`. | both |
| `recording.finish.keeps-folder-and-reports-frames` | Finishing a recording keeps its folder, reports its frame count, and a second finish fails. | both |
| `recording.start.failed-open-removes-folder` | A recording whose capture fails to open removes its folder and leaves nothing running. | both |
| `recording.start.failed-start-removes-folder` | A recording whose capture fails to start removes its folder and leaves nothing running. | both |
| `recording.start.no-first-frame-stops-and-removes` | A recording without a first frame is stopped and its folder removed. | both |
| `recording.start.rejects-while-running` | Starting a recording while one is running fails and creates no folder. | both |
| `recording.abort.stops-removes-and-allows-next` | Aborting a recording stops it, removes its folder, and allows the next recording. | both |
| `recording.target.prepared-each-recording` | Every recording prepares its target again, including the same target, because the preparation fixes the stream output size at the window's current size. | both |
| `recording.target.different-target-reopened` | Recording a different target prepares it again. | both |
| `recording.abort.reports-stop-failure-and-removes-folder` | An abort whose stop fails reports the stop error and still removes the folder. | both |
| `sidecars.send.delivers-only-to-owning-window` | Each window's sidecar message returns as an event only to that window with the sidecar, surface, and body unchanged. | both |
| `sidecars.send.rejects-surface-owned-by-another-window` | Sending to a surface that another window owns fails with "another window". | both |
| `sidecars.protocol.request-lines-carry-surface-root-body` | The sidecar receives surface, root, and body request lines in send order. | both |
| `sidecars.close-owner.sends-closed-per-surface` | Closing a window's ownership sends a closed notice for each of its surfaces. | both |
| `sidecars.close.keeps-other-sessions` | Closing a removed surface sends a closed notice for that surface only; the window's other sessions, including plugin state sessions that are not surfaces, stay open and keep the root of their first request after the window's project is released. | both |
| `sidecars.retain.sends-layout-and-known-surfaces` | Retaining sends each running or published persistent service one `retain` request whose surfaces are the given layout surfaces and every surface this process has sent, an empty array when there are none, and returns the service's closed count. | both |
| `sidecars.retain.reports-service-failure` | A `retained` reply with `ok: false` is returned as an error that carries the service's reason. | both |
| `sidecars.retain.skips-service-without-endpoint` | Retaining without a running service or its endpoint file starts no service and closes nothing. | both |
| `sidecars.retain.rejects-after-stop` | A retain that starts after the sidecars stop, or that a stop interrupts after the service is prepared, fails with "sidecars are stopped" and sends no retain to the service. | both |
| `menu.application.view-has-full-screen-and-text-size` | The application menu's View menu has full screen and the [text size](text-size.md) items with Command `=`, `-`, and `0`; no menu item zooms or reloads the whole webview. | both |
| `sidecars.protocol.surface-keeps-its-first-root` | After the owning window changes project, requests and the closed notice of an open surface carry the root of its first request. | both |
| `sidecars.protocol.closed-surface-messages-are-discarded-and-unknown-ones-fail` | A stdio sidecar message for a surface that the host closed is discarded, while a message for a surface that the host never sent to that process fails the sidecar with `unknown surface <surface>` delivered to the surfaces that sent. | both |
| `sidecars.send.rejects-undeclared-sidecar` | Sending to a sidecar that no plugin declares fails with "not declared". | both |
| `sidecars.send.rejects-after-stop` | Sending after the sidecars stop fails with "stopped". | both |
| `sidecars.send.rejects-when-no-plugin-declares-sidecars` | Without declared sidecars, construction succeeds and every send fails with "not declared by any plugin". | both |
| `sidecars.start.fails-on-missing-executable` | A declared executable missing on disk makes the first send fail with the sidecar name. | both |
| `sidecars.declaration.fails-on-missing-sidecar-json` | An installed sidecar folder without sidecar.json makes the installed sidecar lookup fail with its path. | both |
| `sidecars.declaration.rejects-executable-escaping-package` | An executable path outside the package makes construction fail. | both |
| `sidecars.declaration.rejects-absolute-executable` | An absolute executable path makes construction fail. | both |
| `sidecars.declaration.rejects-unsupported-protocol` | An unsupported protocol version makes construction fail. | both |
| `sidecars.declaration.rejects-unknown-transport` | An unknown transport makes construction fail with "is not supported". | both |
| `sidecars.declaration.persistent-requires-config-directory` | A persistent transport without a configuration directory makes construction fail. | both |
| `sidecars.persistent.accepts-non-canonical-config-directory` | A persistent transport accepts a configuration directory path that is not canonical. | both |
| `sidecars.send.fails-fast-when-sidecar-not-keeping-up` | Large sends to a sidecar that does not read end with "is not keeping up". | both |
| `sidecars.send.slow-sidecar-does-not-block-others` | While one sidecar queue is full, a send to another sidecar returns within 50 ms. | both |
| `sidecars.send.start-does-not-block-other-sidecars` | While a persistent service delays its hello reply, a send to another running sidecar returns within 50 ms. | both |
| `sidecars.close.answer-ends-closing` | After `closed` is sent, `host.sidecars` lists the surface until the sidecar answers, then the list is empty. | both |
| `sidecars.close.failed-answer-is-logged` | A close answer with `error` writes "sidecar <name>: close <surface>: <error>" to the host log and ends the closing entry. | both |
| `sidecars.close.unexpected-answer-fails` | A close answer for a surface that the host is not closing fails the sidecar with "unexpected close answer for <surface>". | both |
| `sidecars.close.process-end-clears-closing` | When a sidecar process ends without answering, its surfaces leave `host.sidecars`. | both |
| `sidecars.stop.honors-stop-timeout` | Stop returns within twice the stop timeout for a sidecar that does not drain its input. | both |
| `sidecars.stop.graceful-on-stdin-eof` | A sidecar that exits on end of input stops without waiting for the timeout. | both |
| `sidecars.stop.kills-after-timeout` | A sidecar that ignores end of input is killed after the stop timeout. | both |
| `sidecars.stop.closes-unread-output` | When the host stops reading a standard input and output sidecar's output, during a stop or after a failure, it closes its end of the pipe, so a sidecar that writes more than the pipe holds on its way out gets a write error and ends without the force-kill. | both |
| `sidecars.stop.forgets-running-sidecars` | Stop removes every sidecar from the running set and clears unanswered closes before it ends their input, so closing a surface or an owner window afterwards sends nothing and reports no closing surface. | both |
| `sidecars.protocol.message-at-limit-is-delivered` | A sidecar message of exactly 67108864 bytes before its newline reaches the owning window intact. | both |
| `sidecars.failure.oversize-message-terminates-and-notifies` | A line longer than 67108864 bytes ends the sidecar process and delivers `sidecar-failure` with "exceeds" to the owning window without waiting for the line to end. | both |
| `sidecars.failure.invalid-message-terminates-and-notifies` | A line that is not JSON, or a JSON object without `body`, ends the sidecar process and delivers `sidecar-failure` with "invalid message". | both |
| `sidecars.failure.output-close-notifies-each-surface` | A sidecar whose output ends while the host is not stopping delivers `sidecar-failure` with "output closed" to the owning window of each surface that sent to it, and the next send starts a new process. | both |
| `sidecars-transport.endpoint.concurrent-hosts-share-authenticated-service` | Two hosts authenticate to one service endpoint with its token and each receive their own events. | both |
| `sidecars-transport.hello.declares-protocol-one` | The hello request declares protocol 1. | both |
| `sidecars-transport.reconnect.after-connection-loss-preserves-owner` | After the service drops the connection, the next send reconnects and events still reach the owner and surface. | both |
| `sidecars-transport.stop.close-owner-failure-returns-promptly` | A close-owner failure reply does not delay stop beyond 1 s. | both |
| `sidecars-transport.hello.rejects-auth-failure` | A failed hello reply makes the send fail with "authentication handshake failed". | both |
| `sidecars-transport.hello.rejects-unsupported-protocol-without-replacing-endpoint` | A hello reply with another protocol fails the send and leaves endpoint.json unchanged. | both |
| `sidecars-transport.hello.times-out` | A service that receives the hello and does not answer fails the send after 5 s with "the service did not answer hello within 5s". | both |
| `sidecars-transport.startup.times-out` | A started service that prints no endpoint within the ready bound fails the send with "the service did not print its endpoint within <bound>", and the host ends and reaps it. | both |
| `sidecars-transport.startup.exits-before-endpoint` | A started service that ends before its endpoint fails the send with "service exited before endpoint". | both |
| `sidecars-transport.endpoint.replaces-dead-service-endpoint` | An endpoint left by a dead service is replaced by the new service endpoint. | both |
| `sidecars-transport.endpoint.live-unreachable-reported-without-replacement` | An endpoint of a live but unreachable service fails the send and is not replaced. | both |
| `sidecars-transport.stop.close-owner-then-shutdown` | Stop sends close-owner and, after a successful reply, shutdown. | both |
| `sidecars-transport.stop.accepts-close-answers-sent-before-stop` | A persistent service's answer to a closed notice sent before the stop, arriving after the stop began, is accepted; stop still sends shutdown and no surface stays closing. | both |
| `sidecars-transport.persistent.revives-a-lost-connection` | When the service drops the connection, the host restarts it without a send and the owning surface receives the connection event. | both |
| `sidecars-transport.endpoint.zombie-service-does-not-exist` | A zombie service pid does not count as an existing service, so its stale endpoint is replaced. | both |
| `sidecars-transport.persistent.revive-failure-is-reported` | A failed restart reports the disconnection and its reason to the owning surface. | both |
| `sidecars-transport.persistent.oversize-line-fails-the-connection` | A service line longer than the 64 MiB message limit closes the connection and delivers `sidecar-failure` with `message exceeds 67108864 bytes` to the surface that sent, without reading the rest of the line. | both |
| `sidecars-transport.persistent.invalid-event-fails-the-connection` | A service line that is not a JSON object or a surface event without a string `surface` closes the connection and delivers `sidecar-failure` with `invalid message: ...` to the surface that sent; the next send reconnects. | both |
| `webkit-children.reap.requires-alive-webkit-same-start` | A recorded WebKit child is killed only when it is alive, still a WebKit process, and its start time matches the record. | both |
| `surface-activation.owner.resolves-registered-view` | A registered native view resolves to its surface id. | both |
| `surface-activation.owner.ignores-unknown-view` | An unregistered native view resolves to no surface. | both |
| `surface-activation.owner.ignores-empty-owner` | A view registered with an empty surface id resolves to no surface. | both |
| `surface-activation.create.propagates-native-failure` | A failed native surface creation returns an error with the native error and the surface id. | both |
| `surface-activation.create.rejects-nil-handle` | A native surface creation that returns no handle fails with "nil handle". | both |
| `surfaces-geometry.rect.accepts-zero-size` | A rectangle with a zero size is valid. | both |
| `surfaces-geometry.rect.rejects-negative-size` | A rectangle with a negative size is rejected, not clamped. | both |
| `surfaces-geometry.rect.rejects-non-finite` | A rectangle with a non-finite size is rejected. | both |
| `surfaces-geometry.sync.rejects-surface-rect-before-layout` | The check that runs before the layout transaction begins refuses a sync request whose surface rectangle has a negative size, with `surface "<id>" geometry must not have a negative size`, and accepts a valid request. | both |
| `surfaces-geometry.sync.rejects-overlay-rect-before-layout` | The check that runs before the layout transaction begins refuses a sync request whose window overlay rectangle has a negative size, with `window overlay geometry must not have a negative size`, and returns the overlays of a valid request with their visibility. | both |
| `surfaces.sync.failure-leaves-no-begun-layout` | A surface sync places the window overlays before it begins the layout transaction, so a refused overlay begins none, and it cancels the begun transaction when a later step fails; a successful sync does not cancel it. | both |
| `exposure.status-change.refuses-host-name` | A status change that the main page sends for a name that starts with `host.` is refused with `the page cannot change host status <name>`, and a change of another name is accepted. | both |
| `images.calls.name-the-call` | A failure of an image region call after its arguments decode is `<call>: <reason>` with the call name `imageAttach`, `imageFocus`, `imageCaret`, `imageText`, or `imageDetach`. | both |
| `host-calls.decode.messages` | The argument decoder refuses a missing or `null` required field, a value of another JSON type, a number outside an integer field's range or with a fraction, a `null` argument, and a fixed-length array of another length with the messages of [host calls](native-host.md#host-calls), and accepts a missing or `null` optional field. | both |
| `host-calls.native.image-argument-lists` | A surface page's `ImageCaret` call with a request and four coordinates and its `ImageText` call with a request and a text decode their own argument lists and reach the caller check. | wailsv3 only: the Wails page runtime sends surface page calls through the native bridge, which decodes their argument lists in the host; Tauri surface pages call the commands of the main page. |
| `host-calls.decode.every-binding` | Every argument of every `Host` binding is raw JSON that the binding decodes before it does anything else, so the framework decodes no argument. | wailsv3 only: Go reflection lists the bindings at run time; `make hosts-check` requires every Tauri command argument other than a framework object to be `Argument<T>`. |
| `termination.signal.first-requests-quit-second-ends-process` | The first termination signal requests quit, and the second ends the process. | both |
| `window-close.surfaces.closes-regions-then-surface` | Closing a window closes, for each logical surface in id order, its document regions and image regions and then the surface, and removes their names from the window's document and image registries. | both |
| `window-close.surfaces.reports-every-failure` | A failed native close does not stop the remaining closes, and the window close returns every failure with its surface id and object kind. | both |
| `window-overlay.rects.packs-four-values-per-rect` | Visible overlays pack into x, y, width, height values in input order. | both |
| `window-overlay.rects.filters-hidden` | Hidden overlays are left out of the packed list. | both |
| `workspace.config-dir.creates-requested-path` | Preparing a missing configuration directory creates it and returns its canonical path. | both |
| `workspace.config-dir.creates-owner-only` | A configuration directory that preparation creates has mode 0700, and an existing directory keeps its mode. | both |
| `workspace.config-dir.rejects-empty-path` | An empty configuration directory path is rejected. | both |
| `workspace.config-dir.rejects-path-under-file` | A configuration directory path under a regular file is rejected. | both |
| `workspace.settings.project-file-holds-only-overrides` | The project settings file holds only the project overrides. | both |
| `workspace.settings.persist-across-reopen` | A workspace opened again on the same configuration directory shows the saved common and project settings. | both |
| `workspace.settings.reset-removes-override` | Removing a project override leaves an empty project settings object. | both |
| `workspace.settings.rejects-project-opening-override` | A project override of projectOpening is rejected. | both |
| `workspace.settings.invalid-common-file-not-overwritten` | An invalid common settings file makes a settings change fail and stays byte-identical. | both |
| `workspace.settings.concurrent-patches-preserved` | Concurrent common settings changes of different keys are all kept. | both |
| `workspace.projects.move-reorders` | Moving a project changes its position in the saved order. | both |
| `workspace.projects.move-requires-delta` | A `move` request without `delta`, or with `delta` `null`, fails with `move delta is missing` and leaves the order unchanged. | both |
| `workspace.projects.plugin-data-patched` | A project patch stores its `plugins` object, and a patch of another unknown field is rejected. | both |
| `workspace.projects.remove-keeps-remaining-order` | Removing a project keeps the order of the remaining projects. | both |
| `workspace.folder.aliases-share-identity` | A directory and a symbolic link to it resolve to the same project folder. | both |
| `workspace.folder.rejects-file` | A regular file is rejected as a project folder. | both |
| `workspace.folder.messages` | A folder check fails with one message that names the requested path once: `project directory does not exist: <path>` for a missing path or a missing ancestor, `project directory is not readable: <path>` when access is denied, `not a project directory: <resolved path>` for a file, and `project directory cannot be resolved: <path> (errno <n>)` for another system error. | both |
| `cli.usage.unknown-command-exits-2` | An unknown command exits with status 2 and prints `sok: unknown command: <word>` and the usage on standard error. | both |
| `cli.endpoint.missing-file-reports-not-running` | Without `endpoint.json` a command exits with status 1 and reports that the file does not exist and the application is not running. | both |
| `cli.output.indents-result-keeping-key-order` | A result is printed with two-space indentation in the key order the endpoint sent, with `{}` and `[]` for empty containers. | both |
| `cli.window.single-window-is-default` | Without `--window` or `--project` a command uses the only window of the application. | both |
| `cli.window.several-windows-need-selection` | With several windows and no selection, or with both `--window` and `--project`, a command exits with status 2 and names the windows or the conflict. | both |
| `cli.window.project-selects-by-canonical-folder` | `--project` selects the window whose open project folder equals the given directory after both are resolved to canonical paths. | both |
| `cli.requests.carry-command-parameters` | `status`, `exposures`, `capture`, `dom` and `input` send the endpoint method and parameters that the specification names, with numbers as JSON numbers and omitted options left out. | both |
| `cli.error.reports-endpoint-code` | An endpoint error exits with status 1 and prints `sok: <message> (<code>)`. | both |
| `cli.error.unwritable-stderr-exits-3` | When sok cannot write its error to standard error, it exits with status 3 instead of 1 or 2. | both |
| `cli.diagnostics.capture-only-in-diagnostic-builds` | A diagnostic build of sok sends `capture` as `diagnostics.capture.still` with the selected window; any other build rejects `capture` as a usage error, `capture needs a diagnostic build of sok`, and contains no diagnostic method. | both |
| `cli.status.watch-prints-value-and-changes` | `status --watch` prints the current value and then each change of the same status as one compact JSON line, and ignores changes of other statuses. | both |
| `cli.config-dir.default-uses-application-identifier` | Without `--config-dir` the command uses `<user configuration directory>/<application identifier>`. | both |
| `cli.identity.build-identifier` | A release build uses `app.soksak.<wails or tauri>`; a diagnostic build uses the identifier with `.dev`. | both |
| `cli.command.flags-from-schema` | A declared command runs through `command.run` with the window, the surface and parameters converted from its flags by the declared schema: text, numbers, integers, booleans, enum values, `null` for a nullable type, JSON objects and arrays, and a value after `=` that starts with `--`; `--params` gives the whole object. | both |
| `cli.command.rejects-undeclared-or-invalid-values` | An undeclared flag, a value that does not match its schema, a flag without its value, a boolean followed by a value, `--params` with parameter flags, and an undeclared command exit with status 2 before `command.run` is sent. | both |
| `cli.commands.lists-declared-commands` | `sok commands` prints the `commands` list of `exposure.list` in the order the application declares them. | both |
| `cli.path.writes-and-removes-the-entry` | `sok path install` writes `<paths directory>/<identifier>` holding the directory of the running `sok` and prints the file and directory; repeating it gives the same file; `sok path remove` deletes it and succeeds when it is absent; a failed write reports the file and `run sudo sok path install`. | both |
| `cli.path.fails-without-a-path-entry-folder` | On an operating system without a path entry folder, `sok path install` fails with the platform's reason, such as `path entries are not implemented on linux`, and writes nothing. | both |
| `cli.pack.writes-sorted-plugin-archive` | `sok plugin pack` writes `<id>-<version>.tgz` with `package.json` and the listed files sorted by path, mode 0644 or 0755, time 0 and owner 0, prints `archive`, `id`, `sha256` and `version`, and writes the same bytes when repeated. | both |
| `cli.pack.rejects-links-and-manifest-mismatch` | A symbolic link in a listed directory, a `plugin.json` without an id, or `soksak.sidecars` that differ from `plugin.json` fail with exit status 1 and leave the output directory empty. | both |
| `cli.pack.diagnostics-only-with-flag` | `sok plugin pack` leaves out `diagnostics.json` and its module, `--diagnostics` adds both, packing fails when `files` lists either, and `--diagnostics` outside `plugin pack` exits 2. | both |
| `cli.pack.rejects-unlisted-modules` | `sok plugin pack` fails with exit status 1 and names the module when the surface module, a section module of either orientation or the state module of `plugin.json` is outside the paths that `files` lists. | both |
| `cli.release.writes-asset-and-sums` | `sok sidecar release` writes `<file name>-<version>-<platform>.tar.gz` and keeps one `SHA256SUMS` line per archive sorted by name, replacing a repeated name; an unknown `--platform` exits 2, an unlisted executable exits 1, and a malformed `SHA256SUMS` exits 1 without writing the archive. | both |
| `cli.registry.writes-checked-index` | `sok registry build` reads the registry files, checks every archive hash and the plugin archive's `package.json` and `plugin.json`, writes `index.json` with the declared field order and two-space indentation, and prints `index`, `packs`, `plugins` and `sidecars`; both implementations write the same text. | both |
| `cli.registry.rejects-without-writing` | A malformed hash, an archive whose hash differs, a `package.json` that differs from the entry, a file name that differs from the entry, a missing `revoked.json` and a pack with an unknown plugin exit 1 and leave no `index.json`. | both |
| `cli.plugin.install-extracts-and-records` | `sok registry use` records the checked index as a `file:` URL; `sok plugin install` extracts the plugin and its sidecar version with their modes, writes `installed.json` with the absolute `path` of each extracted folder, prints the plugin entry and its sidecar versions, and changes nothing when repeated. | both |
| `cli.plugin.install-modes-ignore-the-umask` | Under the umask 077, `sok plugin install` still writes an executable at mode 0755 and another file at mode 0644. | both |
| `cli.plugin.install-failure-keeps-state` | Without `plugins/registry.json`, with an archive whose hash differs from the index, or with an archive entry outside the folder, `sok plugin install` exits 1 and leaves no `installed.json`, version folder or extracted file. | both |
| `cli.plugin.update-remove-enable-list` | `sok plugin update` fails for a plugin that is not installed, installs the newest version keeping `enabled` and recording `previous`, and keeps only the version in use and `previous`; `disable` and `enable` set `enabled`; `list` prints `installed.json`; `remove` prints `null`, deletes the plugin and sidecar folders, and fails when repeated. | both |
| `cli.plugin.state-reads-registry-and-installed` | The installer library reports `{registry, index, installed}`: `null` registry and index without `plugins/registry.json`, the index URL and checked index with one, the read error as `index` for an index that cannot be read, and the error for an invalid `installed.json`. | both |
| `cli.plugin.action-runs-the-command` | The installer library runs `install`, `update`, `remove`, `enable` and `disable` with the result of the matching `sok plugin` command and rejects any other action with `unknown plugin action`. | both |
| `cli.file.errors-name-the-path-and-the-reason` | A file operation that fails reports `<path>: <reason>`, where the reason is the operating system error text starting with a lower-case letter: a missing registry index reports `<path>: no such file or directory` and an unreadable `installed.json` reports `<path>: permission denied` | both |
| `install.version.ranges-and-order` | Ranges `x.y.z`, `^x.y.z`, `~x.y.z` and `>=x.y.z <a.b.c` give their declared bounds; versions compare by number; other forms, leading zeros, empty ranges and parts above 4294967295 are rejected with `invalid version`. | both |
| `install.package.fields-and-manifest` | A plugin `package.json` needs a package `name`, a `version`, `engines.soksak` and `files` that list `plugin.json` inside the package; `soksak` holds only `sidecars`; `soksak.sidecars` must name exactly the `sidecars` of `plugin.json`. Each failure names the field. | both |
| `install.registry.entries` | Registry plugin, sidecar, pack and revoked entries reject unknown fields, a URL that is not an absolute `file:` URL or that has a query, fragment or invalid escape, a `sha256` that is not 64 lowercase hexadecimal digits, a repeated version, an unknown platform, a `protocol` other than 1, a description above 200 code points, an empty pack and a revoked item without a reason. | both |
| `install.registry.index-cross-checks` | The index rejects format 2, a repeated plugin id or package, a pack that names an unknown plugin, a plugin version that needs an unknown sidecar or a range that no sidecar version satisfies, and a revoked version that is not listed. | both |
| `install.select.newest-usable` | Selection takes the newest plugin version for the core version that is not revoked and the newest sidecar version in range with an asset for the platform, and names the plugin, core version, sidecar and platform when nothing fits. | both |
| `install.select.shared-sidecar` | Selection keeps the sidecar version in use when it satisfies the ranges of every other installed plugin, selects the newest version that satisfies all of them otherwise, ignores the earlier range of the plugin being installed, and on a conflict names each plugin and range. | both |
| `install.names.archives-and-paths` | Archive names are `<id>-<version>.tgz` and `<file name>-<version>-<platform>.tar.gz`, install paths are `plugins/<id>/<version>` and `sidecars/<file name>/<version>/<platform>`, `@scope/name` becomes `scope-name`, and an unknown platform or invalid plugin id is rejected. | both |
| `install.installed.consistency` | `plugins/installed.json` rejects a missing `enabled`, a package installed twice, a plugin or sidecar `path` that is not the folder of the installation rules, a `format` other than 2, a sidecar entry that is not `{ version, path }`, missing `sidecars` objects, a sidecar without a version in use, a version in use outside a plugin's range, and a listed sidecar that no plugin names. | both |
| `install.installed.rejects-another-format` | A `plugins/installed.json` whose `format` is not 2 fails with `<file>: plugins/installed.json: format must be 2` and stays unchanged. | both |
| `installed.document.lists-enabled-plugins` | `/installed-plugins.json` lists the enabled installed plugins sorted by id with `id`, `package`, `version` and the compact content of `plugin.json` as `manifest`, adds the compact content of `diagnostics.json` only in a diagnostic build, and is `{"plugins":[]}` without `installed.json`. | both |
| `installed.document.reports-errors` | A missing or invalid `plugin.json` of an enabled plugin, an invalid `diagnostics.json`, or an invalid `installed.json` makes `/installed-plugins.json` `{"error":...}` with the file and the reason. | both |
| `page.start.document` | The start document is `{"workspace":...,"controls":...}` with the workspace snapshot and the window's `windowControls` answer, in that order. | both |
| `page.start.requires-window` | A start document request answers the document as `application/json` with `no-store` after it starts the requesting window, fails with 400 and `the start document request names no window` without starting anything when the request names no window, and fails with 500 and the reason when the start fails. | both |
| `plugins.state.reports-registry-and-installed` | `pluginsState` returns `registry` and `index` as `null` without `plugins/registry.json`, the index URL and checked index with one, `{"error":...}` as `index` for an index that cannot be read or checked, and the content of `installed.json` or the empty format 1 document without one. | both |
| `plugins.run.changes-like-the-command` | `pluginsRun` with `install`, `update`, `disable`, `enable` and `remove` changes `installed.json` and the folders as the matching `sok plugin` command, returns its output, and sends `plugins-changed` with `{action, plugin}` to every window after each change. | both |
| `plugins.run.rejects-invalid-and-concurrent` | `pluginsRun` rejects an unknown action, a plugin id that is not a non-empty string, a failing operation with the command's message, and a call while another operation runs with `another plugin operation is running`, without a `plugins-changed` event. | both |
| `plugins.registry.sets-like-the-command` | `pluginsUseRegistry` with a registry index writes `plugins/registry.json` and returns `{ index }` as `sok registry use` does; an `index` that is not a non-empty string rejects with `index must be a non-empty string`. | both |
| `fetch.https.reads-a-tls-response` | An `https:` index or archive is read from a TLS server that the configured authorities trust, and an archive whose `sha256` differs from its entry fails. | both |
| `fetch.https.redirects-only-to-https` | A redirect to an `https:` URL is followed up to 5 times; a sixth redirect and a redirect to `http:` fail with their texts. | both |
| `fetch.https.reports-status-size-and-timeout` | A response other than 200, a body larger than the limit and a request slower than the limit fail with `HTTP <status>`, `larger than <bytes> bytes` and `timed out after <seconds> s`. | both |
| `fetch.url.rejects-other-schemes` | An index or archive URL that is neither `https:` nor an absolute `file:` URL fails with `the URL must be https: or an absolute file: URL`. | both |
| `installed.modules.serve-installed-files` | `/modules/<package>/<path>` of an enabled installed plugin serves the file inside its recorded `path`; a missing file or a path with an empty, `.` or `..` segment is not found; a disabled plugin or another package is served by the application frontend. | both |
| `installed.sidecars.resolve-installed-folders` | The host's sidecars are those that the `plugin.json` of each enabled installed plugin names, each with the recorded `path` of its sidecar folder and the `sidecar.json` there; a sidecar without an installed version fails, and an empty configuration has none. | both |
