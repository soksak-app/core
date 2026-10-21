#include <stddef.h>
#include <stdbool.h>

// There is one app DOM per window, and a logical surface is a clipping container without a web view.
void *sp_surface_create(void *mainWebview);
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

void webviewAttachSurface(void *webview, void *mainWebview);
void webviewDetachSurface(void *webview);
// Native plane of the surface. Regions can be placed only below this view.
void *webviewSurfaceNativePlane(void *surface);
// Places the web view of a view in the surface below the native plane, so the overlay mask of the plane does not cut it
// and the regions of the view are drawn above it. Returns false when the surface has no host.
bool sp_surface_place_view(void *surface, void *view);
// Forgets the web view of a view placed in its surface, before the view is closed.
void sp_surface_unplace_view(void *view);
#ifdef __OBJC__
@class NSEvent, NSView;
// A view in the surface coordinate system uses one device pixel per coordinate unit. WebKit uses the wheel delta
// (points) as view coordinate units, so for a wheel event going to view the function returns an event converted to that unit. Outside the surface coordinate system, it returns event.
NSEvent *webviewScrollInViewUnits(NSEvent *event, NSView *view);
#endif
// Makes a web view placed inside the surface web view draw in the same unit as the surface.
void webviewMatchSurface(void *webview, void *surface);
void webviewSetFrame(void *webview, double x, double y, double width, double height);
void webviewGetFrame(void *webview, double *rect);
void webviewSetSurfaceHidden(void *webview, bool hidden);
void webviewSetSurfaceAlpha(void *webview, double alpha);
// Terminates the current WebContent process. Called so that quitting the application leaves no WebKit child process.
bool sp_webview_kill_content_process(void *webview);
// Records that the WebContent process of a web view ended as `error native <kind>: web content process terminated: <address>`.
// Called from the process termination notification of the navigation delegate of web views that the framework did not create (surface, modal).
void sp_webview_log_process_end(void *webview, const char *kind);
// For diagnostic builds, for measurement: makes the WebContent processes in the process pool of webview collect JavaScript objects.
// WebKit removes a replaced previous page in a later collection, so the memory check collects with this after the reload and then measures.
// Returns false when the collection for testing does not exist.
bool sp_webview_collect_garbage(void *webview);

// For diagnostic builds: the number of elements of the main document of webview, with the elements of every open shadow
// root in it, and the number of its documents (the
// main document and its frames), evaluated in the page content world or, when document is true, in the content world
// "soksak-document" of document regions. In the page content world parked is the number of elements of the parked surface
// hosts, which window.__soksakParkedElements() of the workbench returns, because a parked host is outside the document;
// a document world has no parked hosts and gives zero. done is called once on the main thread with error NULL and the
// counts, or with a description of the failure and zero counts. The caller keeps context until done is called.
typedef void (*sp_page_objects_done)(void *context, long elements, long documents, long parked, const char *error);
void sp_webview_count_objects(void *webview, bool document, sp_page_objects_done done, void *context);
// Sets the CSS pixel margins and visibility of the declared DOM overlay. values holds five values per item, in the order
// left, top, right, bottom, visible.
void webviewSetSurfaceOverlays(void *webview, const double *values, size_t count);
