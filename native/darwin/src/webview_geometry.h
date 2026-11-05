#include <stddef.h>
#include <stdbool.h>

// A logical surface is a clipping container without a web view. It is placed in the container of the surface hosts of view,
// the NSView that holds that container and lies in a window. The function makes the container when view holds none. On the
// hosts with a main web view, view is the window composition that sp_window_set_main_webview returns.
void *sp_surface_create(void *view);
// Wraps the main web view in the window composition, which holds the window overlays, the file drop view and, above the web
// view, the container of the surface hosts. Returns the composition that already exists, or NULL when the web view is not
// in a window. sp_window_set_main_webview calls it.
void *sp_webview_window_composition(void *mainWebview);
// The view that holds the surface hosts of window: the window composition of its registered main web view, or its native view. A
// window with neither gives NULL.
void *sp_window_composition(void *window);
// The native view of window, which holds the surface hosts of a window without a main web view: an empty view that the framework
// of the window puts in its content view (docs/spec/native-surfaces.md#surface-host-container). The first call makes it, and the
// window keeps it until it closes.
void *sp_window_native_view(void *window);
// Receives files dropped on the window. event receives {"urls":[file URL...],"x":..,"y":..} (page coordinates).
// When release is not NULL, it is called once on the main thread when the drop view no longer uses context (when the next
// registration replaces the receiver, or when the view is released together with the window). When the function returns false, release is not called and context belongs to the caller.
typedef void (*sp_file_drop_event)(void *context, const char *json);
typedef void (*sp_file_drop_release)(void *context);
bool sp_window_file_drop(void *mainWebview, sp_file_drop_event event, sp_file_drop_release release, void *context);
void sp_surface_close(void *surface);
void *sp_surface_native_plane(void *surface);
void *sp_surface_main_webview(void *surface);
double sp_surface_scale(void *surface);
// Window coordinate rectangle (x,y,w,h) where the app DOM modal or menu takes precedence over native input.
void sp_surface_set_window_overlays(void *mainWebview, const double *rects, size_t count);

// Native plane of the surface. Regions can be placed only below this view.
void *webviewSurfaceNativePlane(void *surface);
// Places the web view of a view in the surface below the native plane, so the overlay mask of the plane does not cut it
// and the regions of the view are drawn above it. Returns false when the surface has no host.
bool sp_surface_place_view(void *surface, void *view);
// Forgets the web view of a view placed in its surface, before the view is closed.
void sp_surface_unplace_view(void *view);
void webviewSetFrame(void *webview, double x, double y, double width, double height);
void webviewGetFrame(void *webview, double *rect);
void webviewSetSurfaceHidden(void *webview, bool hidden);
void webviewSetSurfaceAlpha(void *webview, double alpha);
// Gives the keyboard of the window to the surface, the active surface of the card with the focus ring
// (docs/spec/native-surfaces.md#keyboard-of-a-surface). What already holds it inside the surface keeps it. Otherwise the
// view that last held it in the surface takes it, then the first shown image region, then the web view of the surface. A
// surface that lands on its web view gives the keyboard to the first image region that shows after that, so a surface that
// is not ready when the call comes receives the keyboard when it becomes ready. A left press that is open keeps the
// keyboard where it is until its release, because a first responder that moves during a press ends that press.
void sp_surface_focus(void *surface);
// Gives the keyboard of window to the workbench: the registered main web view, or the view of the framework that draws the
// workbench of a window without a main web view. An open left press delays it as in sp_surface_focus.
void sp_window_focus_workbench(void *window);
// Records a move of the first responder of a window for the surfaces that it leaves and enters. The observation of the first
// responder calls it.
void sp_surface_responder_moved(void *from, void *to);
// Gives the keyboard to the surface that asked for it, now that its image region shows.
void sp_surface_region_shown(void *region);
// A diagnostic release that sp_input_pointer delivered ended the open left press of window.
void sp_surface_press_released(void *window);
// Records that the WebContent process of a web view ended as `error native <kind>: web content process terminated: <address>`.
// Called from the process termination notification of the navigation delegate of web views that the framework did not create (surface, modal).
void sp_webview_log_process_end(void *webview, const char *kind);
// For diagnostic builds, for measurement: makes the WebContent processes in the process pool of webview collect JavaScript objects.
// WebKit removes a replaced previous page in a later collection, so the memory check collects with this after the reload and then measures.
// Returns false when the collection for testing does not exist.
bool sp_webview_collect_garbage(void *webview);

// For diagnostic builds: the number of elements of the main document of webview, with the elements of every open shadow
// root in it, and the number of its documents (the main document and its frames), evaluated in the page content world or,
// when document is true, in the content world "soksak-document" of document regions. done is called once on the main thread
// with error NULL and the counts, or with a description of the failure and zero counts. The caller keeps context until done is called.
typedef void (*sp_page_objects_done)(void *context, long elements, long documents, const char *error);
void sp_webview_count_objects(void *webview, bool document, sp_page_objects_done done, void *context);
// Sets the CSS pixel margins and visibility of the declared DOM overlay. values holds five values per item, in the order
// left, top, right, bottom, visible.
void webviewSetSurfaceOverlays(void *webview, const double *values, size_t count);
