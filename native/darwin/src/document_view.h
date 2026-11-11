#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// A webview that shows an external document in one region of a surface document.
//
// The document webview is a child view of the surface webview, so it moves, hides, and closes together with the
// surface. It does not share
// the bridge, injected scripts, or data store of the application. Every function is called on the main thread.

// Called when the document state changes. state is the JSON object
//   {url, title, loading, progress, canGoBack, canGoForward, error, scroll: {x, y}, history, link, navigations}
// and is released when the call returns. Called on the main thread.
typedef void (*sp_document_changed)(void *context, const char *state);

// Called when a native document input event occurs. json represents a JSON object and is released when the call
// returns. Called on the main thread.
typedef void (*sp_document_event)(void *context, const char *json);

// A message of a plugin document: the JSON object {"message": <value>} for each message that the document posts to
// its own window, or {"error": <reason>} when its data is not JSON or a post of the page fails. json is released when
// the call returns. Called on the main thread.
typedef void (*sp_document_message)(void *context, const char *json);

// A message of a document stream (docs/spec/native-surfaces.md#document-streams): the JSON object
// {"stream": "elements" | "requests", "message": {...}} where message is {type: "snapshot", seq, nodes, total, truncated},
// {type: "entries", entries} or {type: "reset"}. json is released when the call returns. Called on the main thread.
typedef void (*sp_document_stream)(void *context, const char *json);

// A message of a view page through the sok-view handler (docs/spec/native-surfaces.md#view-surfaces): the JSON object
// {"message": <value>} for each message that the page posts, or {"error": <reason>} when the message comes from a frame that
// is not the main frame. json is released when the call returns. Called on the main thread.
typedef void (*sp_view_message)(void *context, const char *json);

// Creates a document webview hidden inside the surface webview. directory is the absolute path where the persistent
// data store keeps
// site data, and it is created if missing. Documents with the same directory use the same store. folder and plugin
// name
// the installed
// folder and the id of the plugin whose surface owns the region; soksak://<plugin>/<path> serves <path> from that folder,
// and NULL folder serves nothing. channel is NULL for a document region, which receives no core root grant
// (docs/spec/plugin-processes.md, rule 4). A non-NULL channel is the text of the view channel script of a view
// configuration: the script runs at document start in the page world, the sok-view handler is registered, and the
// configuration may request soksak://core/<path> from the core root resolver (sp_core_root_set_resolver). A view needs
// folder and plugin. label is the display label of the WebContent process of the document, which the host composes
// (docs/spec/plugin-processes.md#operating-system-display-labels), and NULL gives the process no label of its own. Returns NULL
// if the webview cannot be created.
void *sp_document_create(void *surface, const char *directory, const char *folder, const char *plugin, const char *label, const char *channel,
    sp_document_changed changed, void *context);

// The cause of the last creation of a document region or view web view that returned NULL on the main thread, as a UTF-8
// string that names the failed step and the native error text. It is "" when the last creation did not fail, and the next
// creation clears it.
const char *sp_document_last_error(void);

// Makes the next creation of a document region or view web view fail with cause, as a failed creation of the native
// layer does, so that the host unit tests of the creation error text run without a failing data store. Only the owning tests
// call it.
void sp_document_fail_creation_for_test(const char *cause);

// Called when the WebContent process of a view ends, before the host closes the view (docs/spec/plugin-processes.md, rule 5). It
// is not called for a closed view. Called on the main thread.
typedef void (*sp_view_ended)(void *context);

// Sets the receiver of the end of the WebContent process of a view. NULL reports none. A document region has no receiver, so its
// process end is handled only by its own state. The caller keeps context while the document lives.
void sp_document_set_view_ended(void *document, sp_view_ended ended, void *context);

// Called when WebKit reports that the WebContent process of a view stops (responsive false) or resumes (responsive true) answering its
// responsiveness check (docs/spec/plugin-processes.md, rule 6). The notice does not end the view or its calls. Called on the main thread.
typedef void (*sp_view_responsiveness)(void *context, bool responsive);

// Sets the receiver of the responsiveness notices of a view. NULL reports none. A document region has no receiver. The caller keeps
// context while the document lives.
void sp_document_set_view_responsiveness(void *document, sp_view_responsiveness receiver, void *context);

// Adds a user script that runs at document start in the page world of the main frame, before any page script, for each load of the
// document from now on (docs/spec/native-surfaces.md#view-surfaces). The host adds the theme script of a view before it loads the page.
// The source is copied. Call it on the main thread before the view loads a page.
void sp_document_add_user_script(void *document, const char *source);

// Sets the receiver of the messages of the sok-view handler of a view. NULL reports none. The caller keeps context while the
// document lives.
void sp_document_set_view_message(void *document, sp_view_message message, void *context);

// Resolves a request of the core root (docs/spec/plugin-processes.md, rule 4) of a view of plugin for the URL path path,
// which names a file of the core host. When the path is served, it returns true and sets bytes to a copy of the file that
// the caller releases with free, length to its size, and type to its content type that the caller releases with free. It
// returns false for a path that is not served. Called on the main thread.
typedef bool (*sp_core_root_resolver)(void *context, const char *plugin, const char *path, void **bytes, size_t *length,
    char **type);

// Sets the core root resolver of the application. NULL serves no core file. The caller keeps context while the application
// runs. Called on the main thread.
void sp_core_root_set_resolver(sp_core_root_resolver resolver, void *context);

// Sets the view import map of the application to the JSON text map (docs/spec/plugin-processes.md, rule 4). The text is
// copied. NULL clears it, and a view page is then refused. Called on the main thread.
void sp_view_import_map_set(const char *map);

// Inserts the import map text map directly after the doctype of the view page html (docs/spec/plugin-processes.md, rule 4).
// It returns true and sets output to the page after the insertion, or it returns false and sets error to the reason of the
// refusal. Each of output and error is a copy that the caller releases with free.
bool sp_view_page_insert(const char *html, const char *map, char **output, char **error);

// Sets the receiver of the messages of plugin documents. NULL reports none. The caller keeps context while the
// document lives.
void sp_document_set_message(void *document, sp_document_message message, void *context);

// Posts the JSON text json to the window of the current plugin document of the region's plugin, which parses it. Returns
// false and posts nothing when the current document is not such a document or json is not UTF-8; a text that is not JSON
// is reported through the message receiver as {error: "post failed: <reason>"}.
bool sp_document_post(void *document, const char *json);

// Sets the receiver of the messages of the document streams. NULL reports none. The caller keeps context while the
// document lives.
void sp_document_set_stream(void *document, sp_document_stream stream, void *context);

// Scrolls the main document of the region to the CSS pixel position and reports the settled position once. The reply is
// {"x": x, "y": y} with the position that the document took, or {"error": reason} for a closed region.
typedef void (*sp_document_scrolled)(void *context, const char *json);
void sp_document_scroll_to(void *document, double x, double y, sp_document_scrolled reply, void *context);

// Shows a confirmation panel that names the kind, the origin and the summary, and reports the answer of the person
// once. The panel blocks no thread: it appears as a floating panel of the window of the region and the reply arrives
// as the click of its button. The reply is {"granted": true} or {"granted": false}.
typedef void (*sp_document_confirm_reply)(void *context, const char *json);
void sp_document_confirm(void *document, const char *kind, const char *origin, const char *summary,
    sp_document_confirm_reply reply, void *context);

// Reads the value of the operable element ref of the frame at path and reports it once. Without the grant the reply is
// {"origin": origin} alone, so the host learns the origin of the frame that it gates on; with the grant the reply is
// {"value": value, "origin": origin}, where a sensitive element answers a null value. The error reply names a closed
// region, an unknown path or a read that failed.
typedef void (*sp_document_read_reply)(void *context, const char *json);
void sp_document_read(void *document, const char *path, int ref, bool granted, sp_document_read_reply reply, void *context);

// Runs one narrow action on the operable element ref of the frame at path. Without the grant the reply names the
// origin of the frame and whether the element is a form submit control or a field of a form, so the host gates on the
// classification of the element it is about to act on; with the grant the reply names the outcome. The action is
// 0 click, 1 fill, 2 press, 3 select; the fill and select actions take a value.
typedef void (*sp_document_act_reply)(void *context, const char *json);
void sp_document_act(void *document, const char *path, int ref, int action, const char *value, bool granted,
    sp_document_act_reply reply, void *context);

// Evaluates a JavaScript expression in the content world of the frame at path and reports the result once. Without
// the grant the reply names the origin of the frame alone; with the grant it names the value of the expression as
// JSON. The error reply names a closed region, an unknown path or a failure of the evaluation.
typedef void (*sp_document_eval_reply)(void *context, const char *json);
void sp_document_eval(void *document, const char *path, const char *source, bool await_promise, bool granted,
    sp_document_eval_reply reply, void *context);

// Dispatches one coordinate input action on the region viewport and reports the outcome once. The action is
// 0 click, 1 move, 2 drag, 3 press, 4 scroll; the reply is {ok: true} or {error: reason}.
typedef void (*sp_document_input_reply)(void *context, const char *json);
void sp_document_input(void *document, int action, double x, double y, double dx, double dy, const char *key,
    sp_document_input_reply reply, void *context);

// Captures the region and reports the result once. The mode is 0 still, 1 sequence, 2 scroll, 3 video. Still
// replies {path} of one PNG of the viewport. Sequence replies {frames, count, limited} of a folder of PNGs at the
// interval. Scroll replies {path} of one stitched PNG of the whole document. Video replies {path, frames, durationMs}
// of one mp4. The interval in milliseconds and the count or duration limit the sequence and video modes. The reply
// is {error: reason} for a closed region or a failure.
typedef void (*sp_document_capture_reply)(void *context, const char *json);
void sp_document_capture(void *document, int mode, int every_ms, int count, int for_ms,
    sp_document_capture_reply reply, void *context);

// Turns the stream "elements" or "requests" of the document on or off; the host turns a stream on while it has a
// subscriber. A stream that is off collects nothing. Turning the element stream on sends a snapshot; turning it off drops
// an unacknowledged snapshot. Returns false for another stream name or a closed document.
bool sp_document_stream_on(void *document, const char *stream, bool on);

// Acknowledges the element snapshot seq. The document sends no further snapshot until the snapshot that it sent last is
// acknowledged, and then one snapshot if the tree changed meanwhile. An acknowledgement of a snapshot sent before a reset
// releases nothing. Returns false for a seq that the document has not sent.
bool sp_document_stream_ack(void *document, unsigned long long seq);

// Sets the receiver of the native events of the document. If event is NULL, no event is reported.
// The caller keeps context while the document lives.
void sp_document_set_event(void *document, sp_document_event event, void *context);

// Opens an http, https, file or soksak address. Refuses another address and returns false.
bool sp_document_load(void *document, const char *url);

// action: 0 back, 1 forward, 2 reload, 3 stop, 4 the session history entry offset entries away from the current
// entry.
// offset is used only with 4; it returns false if offset is 0 or outside the history.
bool sp_document_go(void *document, int action, int offset);

// Sets the region by the CSS pixel margins (left, top, right, bottom) of the surface viewport. The margins are kept
// when the surface size changes.
void sp_document_place(void *document, double left, double top, double right, double bottom, bool visible);
#ifdef SOKSAK_DIAGNOSTIC
// With draw, makes the document regions of window show their documents and render while the window is occluded
// (sp_webview_render_occluded), so a still capture of the covered window holds them; without, ends that, and a covered region
// hides its document again. The window keeps the state for a region created later in it until draw is false or the window
// closes; the regions of other windows and the views keep theirs. Returns false when a region cannot take the state. Call it
// on the main thread.
bool sp_document_draw_covered(void *window, bool draw);
// Adds or removes a diagnostic viewport marker on the document view. The marker is a cyan 2-point layer border.
// All three output pointers are required. On failure, error receives an allocated UTF-8 message for the caller to free.
bool sp_document_viewport_marker(void *document, bool enabled, uint8_t *rgb3, double *borderWidthPt, char **error);

// Replaces only the document identity producer's target-view update completion for its owning test. The production
// default calls WKWebView's existing next-presentation-update API. The test keeps the real API call and controls only
// when its completion is delivered.
typedef void (*sp_document_frame_identity_after_update)(void *document, void (^completion)(void));
void sp_document_frame_identity_test_set_after_update_hook(sp_document_frame_identity_after_update hook);
void sp_document_frame_identity_after_target_update(void *document, void (^completion)(void));

// Completion runs exactly once on the main thread; JSON and error are borrowed until the callback returns. The caller
// keeps context alive until completion, including when the awaiting RPC reaches its own deadline.
typedef void (*sp_document_frame_identity_reply)(void *context, const char *json, const char *error);
// Starts a capture-scoped visible QR producer in the current plugin root document. The caller supplies the active
// host view generation. Call start on the main thread because document is owned by the native window registry.
// Completion reports installation and initial draw acceptance, not presentation. Freeze and remove accept calls from
// any thread and schedule WebKit work on the main thread; false means no callback will follow.
bool sp_document_frame_identity_start(void *document, uint64_t generation,
    sp_document_frame_identity_reply reply, void *context);
// Freezes the producer without removing its last marker. Completion reports generated and actually advanced slot counts.
bool sp_document_frame_identity_freeze(uint64_t generation, sp_document_frame_identity_reply reply, void *context);
// Removes only the matching capture-session marker after capture intake has stopped. Completion runs exactly once on
// the main thread; stale generations are reported as errors and cannot remove a replacement marker.
bool sp_document_frame_identity_remove(uint64_t generation, sp_document_frame_identity_reply reply, void *context);
#endif

// Writes the region in window coordinates and the visibility {x, y, width, height, visible} to out[0..4].
void sp_document_frame(void *document, double *out);

// Sets the page zoom of the document to the text scale zoom (docs/spec/text-size.md). It is kept when the layout and
// the
// surface scale change. Returns false and changes nothing if zoom is not a finite positive number.
bool sp_document_zoom(void *document, double zoom);

// Dims the document while a dialog is open.
void sp_document_background(void *document, bool enabled);

// Sets the native appearance that the document webview and its web content use.
void sp_document_appearance(void *document, bool dark);

// Sets the time in seconds that a document region stays hidden before it clears its back-forward cache
// (docs/spec/native-surfaces.md#document-regions). It is 300 until it is set; a region that is hidden at the call keeps the
// time it started with. Returns false and changes nothing if seconds is not a finite positive number.
bool sp_document_set_hidden_clear_delay(double seconds);

// Clears the back-forward cache of every open document region that has one when the level is `warn` or `critical`; the level
// `normal` clears nothing. The memory pressure owner (memory_pressure.h) calls it on the main thread with each report.
void sp_document_memory_pressure(const char *level);

// The reply of sp_document_query: the JSON object {"media": bool, "capture": bool, "form": bool}, or {"error": <reason>} when
// the region cannot answer. json is released when the call returns. Called once on the main thread.
typedef void (*sp_document_query_reply)(void *context, const char *json);

// Reads the state that the memory saver decides with (docs/spec/plugins.md#memory-saver): media is whether a media element of
// the page plays audible media (the private _isPlayingAudio of the web view), capture is whether the public camera or
// microphone capture state is active, and form is whether a frame document of the region holds a form flag. reply is called
// once before the call returns.
void sp_document_query(void *document, sp_document_query_reply reply, void *context);

// Returns the public interactionState of the region (serialized session history) as base64 in a string that the caller
// releases with free, an empty string when the region has loaded nothing or the web view yields no state, or NULL for a
// closed region.
char *sp_document_interaction_state(void *document);

// Restores the session history state, base64 of an interactionState, into a region that has loaded nothing yet, which then
// loads the current entry of that history. Returns NULL, or a static error text: the region has already loaded a document,
// the state is not base64, or the web view refused it.
const char *sp_document_restore(void *document, const char *state);

// Removes and releases the webview, of a document region or of a view surface. changed is not called afterward.
void sp_document_close(void *document);

// Takes the bytes that the binary store of the region keeps under id (docs/spec/native-surfaces.md#document-regions) and
// releases the id. On success it sets bytes to a copy that the caller releases with free, sets length to its size, and
// returns NULL. It returns a static error text and sets nothing when the region is closed or the id is not stored.
const char *sp_document_binary_take(void *document, const char *id, void **bytes, size_t *length);

// Stores length bytes with their content type in the binary store of the document, a region or a view, under a new id
// (docs/spec/native-surfaces.md#document-regions), with the bounds of an upload: the bytes are not empty, at most 16 MiB,
// and the store holds at most 64 MiB with them. The id is released as an uploaded id is: by a download, by a take or when
// the document closes. On success it writes the 32-character id and its terminating NUL into id and returns NULL. It
// returns an error text that the caller releases with free, and stores nothing, when the document is closed, the bytes are
// empty or over a bound, or the type is not given.
char *sp_document_binary_put(void *document, const void *bytes, size_t length, const char *type, char id[33]);

// Returns the number of ids that the binary store of the region holds. A closed region holds none, so it returns 0.
size_t sp_document_binary_count(void *document);

// Called when the data store of a directory has ended. error is NULL, or the reason the store did not end; it is released
// when the call returns. Called on the main thread.
typedef void (*sp_document_store_closed)(void *context, const char *error);

// Ends the persistent data store of directory, so its folder can be removed: closed is called after the session of the store
// is removed and the WebKit network and GPU processes, which the documents of other stores start again, have ended, so nothing
// writes to the directory any more. Every document of the directory
// must be closed first. A directory without a store ends at once; documents of a directory whose store is ending are not
// created. closed reports an error for a directory that is not an absolute path, a store that is already ending, or an
// open document of the directory.
void sp_document_store_close(const char *directory, sp_document_store_closed closed, void *context);
