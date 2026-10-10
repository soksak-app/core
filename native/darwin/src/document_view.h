#include <stdbool.h>

// A webview that shows an external document in one region of a surface document.
//
// The document webview is a child view of the surface webview, so it moves, hides, and closes together with the
// surface. It does not share
// the bridge, injected scripts, or data store of the application. Every function is called on the main thread.

// Called when the document state changes. state is the JSON object
//   {url, title, loading, progress, canGoBack, canGoForward, error, scroll: {x, y}}
// and is released when the call returns. Called on the main thread.
typedef void (*sp_document_changed)(void *context, const char *state);

// Called when a native document input event occurs. json represents a JSON object and is released when the call
// returns. Called on the main thread.
typedef void (*sp_document_event)(void *context, const char *json);

// A message of a plugin document: the JSON object {"message": <value>} for each message that the document posts to
// its own window, or {"error": <reason>} when its data is not JSON or a post of the page fails. json is released when
// the call returns. Called on the main thread.
typedef void (*sp_document_message)(void *context, const char *json);

// Creates a document webview hidden inside the surface webview. directory is the absolute path where the persistent
// data store keeps
// site data, and it is created if missing. Documents with the same directory use the same store. folder and plugin
// name
// the installed
// folder and the id of the plugin whose surface owns the region; sok://<plugin>/<path> serves <path> from that folder,
// and NULL folder serves nothing. Returns NULL if the webview cannot be created.
void *sp_document_create(void *surface, const char *directory, const char *folder, const char *plugin,
    sp_document_changed changed, void *context);

// Sets the receiver of the messages of plugin documents. NULL reports none. The caller keeps context while the
// document lives.
void sp_document_set_message(void *document, sp_document_message message, void *context);

// Posts the JSON value json to the window of the current plugin document of the region's plugin. Returns false and
// posts nothing when the current document is not such a document or json is not JSON.
bool sp_document_post(void *document, const char *json);

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

// Removes and releases the webview. changed is not called afterward.
void sp_document_close(void *document);
