# Terminal runtime

[한국어](terminal-runtime.ko.md)

This contract defines the approved terminal runtime. Implementation and verification are tracked in [features](../features.md); approval of this contract does not establish implementation.

## Ownership and process count

One persistent terminal service owns PTYs, VT state, scrollback, and rendering for one application configuration directory. PTY management, emulation, rendering, and client transport are separate modules in that process, not separate executables. Independent sessions own separate PTY devices and shell processes. A PTY device is not a process. Three independent terminals require one service and three shells, in addition to the application host. WebKit processes and programs launched by shells are counted separately.

A surface attachment is not a session. The first open for a surface key creates one registry actor and allocates a stable session identifier before starting its shell; repeated requests with the same creation identifier return the same result. Attaching a replacement surface does not create a PTY. The active attachment owns input and size changes, and stale attachments receive an explicit error. A session preserves its terminal dimensions when no surface is attached.

The service endpoint is scoped to the configuration directory, authenticated, versioned, and protected by a single-instance lock. A test configuration cannot discover a service belonging to another configuration. Session state and input queues are isolated. A busy session must not hold a global lock while reading, writing, emulating, or rendering.

## Closing and recovery

### Service transport

The sidecar declaration selects `transport: "persistent"`. A sidecar without that field uses its domain's stdio transport. A host starts the declared executable with `--service-dir <config-dir>/services/<executable-name>`. The service takes the exclusive lock in that directory before creating its listener. It creates the socket in a private, short temporary directory to respect Unix socket path limits and atomically publishes `endpoint.json` containing `{protocol: 1, pid, socket, token}`. Directory permissions are 0700 and token-bearing files are 0600. The ready line on stdout contains that endpoint only after the listener is ready.

The first newline-delimited JSON message is `{operation: "hello", protocol: 1, token, client}`. The service replies `{operation: "hello", protocol: 1, ok: true}` or `{operation: "hello", ok: false, error}`. After authentication, surface messages retain the declared sidecar envelope. `{operation: "close-owner", request}` closes the authenticated client's sessions and replies `{operation: "closed-owner", request, ok: true}` after cleanup, or `ok: false` with `error`. `{operation: "shutdown", request}` is accepted only after owner close, replies `{operation: "shutdown", request, ok: true}`, and authorizes the service to exit after its client connections finish. Socket EOF preserves sessions. An endpoint file alone does not authorize killing its PID, and protocol or authentication failure must not start a competing service.

Hiding a surface, visiting the library, or losing the application connection preserves sessions. Closing a terminal explicitly ends that session. Closing a window normally ends its owned sessions; normal application quit ends all owned sessions. Closing is complete only after the managed jobs are terminated, the child is reaped, PTY handles are released, output completion or failure is reported, and attachment tasks are removed. Shutdown errors are reported, not converted into success.

Application crashes and explicit update restarts leave the service alive. Reconnection restores the same session, shell process, VT state, and scrollback; the native image is recreated for the new application process and is never reused across processes. The service continues consuming and interpreting output while detached. EOF is a connection loss, not a session-close command. A close intent is recorded before acknowledgement so an interrupted close cannot restore a deliberately closed session.

The service exits only after an explicit shutdown request and after no clients remain. Recoverable sessions are listed and can be explicitly closed. Service failure and OS restart are outside live-process recovery; a new shell is not evidence of recovery. The shared service is one process failure domain. Session isolation does not claim process-level crash isolation.

An application update may reconnect to the live service only when their protocol versions agree. A protocol mismatch is an explicit failure; it does not start a second service, close existing work, or use a compatibility path. Replacing the service itself waits until its sessions end.

## Terminal input and display

A single pointer click on a terminal transfers keyboard ownership to its native image region through the declared `terminal.focus` command. The host restores the target document WebView as the responder before delivering a later synthetic pointer after native terminal input, so a native image responder cannot strand the next click. The DOM anchor prevents the pointer's default DOM-focus action so WebKit cannot take ownership back during the same click. Card selection still receives the event. No second click, delayed refocus, or test-only focus command is required. Focus-request errors remain observable. Modal focus restoration and image focus notifications are deferred past the active AppKit/Tauri callback; they must not synchronously re-enter the WebView event path.

The engine, PTY, and displayed raster agree on the applied dimensions. Narrowing reflows soft-wrapped primary-screen lines; widening joins those same logical lines. Explicit newlines remain. Alternate-screen applications retain their terminal-controlled layout semantics. Divider movement never changes font metrics or animates raster geometry.

The terminal raster follows the effective application appearance. The surface page sends `theme` with `{ "mode": "dark" }` or `{ "mode": "light" }` to the terminal sidecar whenever the application appearance changes. The sidecar rejects any other mode explicitly. The selected mode changes the default foreground, background, cursor, and indexed ANSI colors for subsequent and existing screen cells; it does not recreate the PTY, session, text, cursor position, or cell metrics. The mode is an image-surface property and is applied to the next complete frame; an in-flight transfer remains immutable.

Cursor state includes position, visibility, shape, blink policy, and colors. The cursor policy is explicit: shape is `block`, `underline`, or `beam`; blink is `Never`, `Off`, `On`, or `Always`; interval is a positive millisecond value (default 750); idle timeout is a nonnegative millisecond value (default 5000, with zero disabling the timeout); and unfocused rendering is `hollow`, `solid`, `underline`, `beam`, or `unchanged`. Defaults are a filled block with `Off` blinking while focused and a steady hollow block while unfocused. `Never` and `Always` override the program blink request; `Off` and `On` permit it. A program cursor shape overrides the configured default. Program visibility is authoritative. Rendering changes only the cursor pixels: it has no fade or size animation and never recreates the PTY or changes cell metrics.

The policy is declared by the terminal plugin in `plugin.json`, receives the application's initial value from `environment.json`, and then follows the effective common/project settings. The workbench validates each value against the declaration before persistence, publishes the effective plugin-local settings to mounted terminal surfaces, and reports an explicit error without applying a partial patch when a value is invalid. A terminal surface sends the complete policy to its sidecar at startup and after every effective settings change.

Native IME owns marked text. Preedit is displayed without writing partial syllables to the PTY. Committed text is delivered exactly once in the same ordered queue as ordinary input. Caret coordinates anchor the candidate window. Unsupported native text values and failed input operations are explicit errors.

Selection, clipboard, paste, file drop, image paste, and terminal-generated image display are distinct operations. Pasted images are stored as owned files and their paths are inserted without automatic execution. Bracketed paste respects terminal mode. No input is silently sanitized, discarded, or reordered. Terminal protocol support is recorded per sequence and reference revision; an unimplemented operation does not count as supported because its parser accepts it.

## Verification

- Record a failing baseline before each correction and run the same assertion after correction.
- Measure service processes, shell identities, PTY descriptors, attachments, and output sequences through creation, normal close, crash, and reconnection.
- Exercise at least three terminals in both native hosts. Capture complete fast divider gestures, unchanged glyph metrics, native clipping, coverage, and restored regions.
- Observe real native keyboard and IME input, not only injected committed strings. Test semantic state and displayed pixels independently.
- Keep loading, ready, and error distinct. Ready includes actual first native presentation, not only successful session creation.
