#include <stdbool.h>
#include <stddef.h>

// A webview that shows an external document in one region of a surface document.
//
// The document webview is a child view of the surface webview, so it moves, hides, and closes together with the
// surface. It does not share
// the bridge, injected scripts, or data store of the application. Every function is called on the main thread.

// Called when the document state changes. state is the JSON object
//   {url, title, loading, progress, canGoBack, canGoForward, error, scroll: {x, y}, history, link}
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
// folder and the id of the plugin whose surface owns the region; sok://<plugin>/<path> serves <path> from that folder,
// and NULL folder serves nothing. channel is NULL for a document region, which receives no core root grant
// (docs/spec/plugin-processes.md, rule 4). A non-NULL channel is the text of the view channel script of a view
// configuration: the script runs at document start in the page world, the sok-view handler is registered, and the
// configuration may request sok://core/<path> from the core root resolver (sp_core_root_set_resolver). A view needs
// folder and plugin. Returns NULL if the webview cannot be created.
void *sp_document_create(void *surface, const char *directory, const char *folder, const char *plugin, const char *channel,
    sp_document_changed changed, void *context);

// Creates the plugin host web view of plugin hidden in the window itself (docs/spec/plugin-host.md). directory is the
// absolute path where the persistent data store keeps site data, and it is created if missing; documents with the same
// directory use the same store. folder and plugin name the installed folder and the id of the plugin whose host the web
// view runs, so sok://<plugin>/<path> serves <path> from that folder and the configuration carries the view
// configuration: the view channel script channel runs at document start in the page world, the sok-view handler is
// registered, and the configuration may request sok://core/<path> from the core root resolver
// (sp_core_root_set_resolver). changed receives the state JSON of the web view. The web view holds a zero frame, is
// hidden, draws nothing, takes no hit testing, receives no input, and never becomes the first responder. Returns NULL
// if the webview cannot be created.
void *sp_plugin_host_create(void *window, const char *directory, const char *folder, const char *plugin,
    const char *channel, sp_document_changed changed, void *context);

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

// Sets the receiver of the messages of plugin documents. NULL reports none. The caller keeps context while the
// document lives.
void sp_document_set_message(void *document, sp_document_message message, void *context);

// Posts the JSON value json to the window of the current plugin document of the region's plugin. Returns false and
// posts nothing when the current document is not such a document or json is not JSON.
bool sp_document_post(void *document, const char *json);

// Sets the receiver of the messages of the document streams. NULL reports none. The caller keeps context while the
// document lives.
void sp_document_set_stream(void *document, sp_document_stream stream, void *context);

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

// Opens an http, https, file or sok address. Refuses another address and returns false.
bool sp_document_load(void *document, const char *url);

// action: 0 back, 1 forward, 2 reload, 3 stop, 4 the session history entry offset entries away from the current
// entry.
// offset is used only with 4; it returns false if offset is 0 or outside the history.
bool sp_document_go(void *document, int action, int offset);

// Sets the region by the CSS pixel margins (left, top, right, bottom) of the surface viewport. The margins are kept
// when the surface size changes.
void sp_document_place(void *document, double left, double top, double right, double bottom, bool visible);

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

// Removes and releases the webview, of a document region or of a plugin host. changed is not called afterward.
void sp_document_close(void *document);

// Takes the bytes that the binary store of the region keeps under id (docs/spec/native-surfaces.md#document-regions) and
// releases the id. On success it sets bytes to a copy that the caller releases with free, sets length to its size, and
// returns NULL. It returns a static error text and sets nothing when the region is closed or the id is not stored.
const char *sp_document_binary_take(void *document, const char *id, void **bytes, size_t *length);

// Returns the number of ids that the binary store of the region holds. A closed region holds none, so it returns 0.
size_t sp_document_binary_count(void *document);

// Called when the data store of a directory has ended. error is NULL, or the reason the store did not end; it is released
// when the call returns. Called on the main thread.
typedef void (*sp_document_store_closed)(void *context, const char *error);

// Ends the persistent data store of directory, so its folder can be removed: closed is called after the WebKit network
// process has removed the session of the store and writes nothing more to the directory. Every document of the directory
// must be closed first. A directory without a store ends at once; documents of a directory whose store is ending are not
// created. closed reports an error for a directory that is not an absolute path, a store that is already ending, or an
// open document of the directory.
void sp_document_store_close(const char *directory, sp_document_store_closed closed, void *context);
