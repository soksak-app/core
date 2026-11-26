#include <stddef.h>
#include <stdbool.h>

// A logical surface is a clipping container without a web view. It is placed in the container of the surface hosts of view,
// the NSView that holds that container and lies in a window. The function makes the container when view holds none. On the
// hosts with a main web view, view is the window composition that sp_window_set_main_webview returns.
void *sp_surface_create(void *view);
// Marks the surface host as the dialog host of its container (docs/spec/native-surfaces.md#surface-host-container): a surface host that
// sp_surface_create makes in that container while the dialog host is in it is inserted below the dialog host, so the dialog stays above
// every other surface host. The host marks the surface host of a dialog surface when it creates it. Call it on the main thread.
void sp_surface_mark_dialog(void *surface);
// Seats the surface host of the settings surface above the modal web view modal of the settings window
// (docs/spec/native-modals.md#settings-surface): the host moves into the settings container of the window, a container of surface
// hosts that stands directly above modal and whose frame is the clip x, y, width, height, in points from the top left of the
// content area, so the host shows and takes the pointer only inside the clip and modal takes every other point. A later call
// changes the clip and stands the container above modal again. Returns false when modal is not a view of the content view of the
// window of the host. Call it on the main thread, before the frame of the host is set, because the frame of the host is relative to
// its container.
bool sp_surface_seat_over_modal(void *surface, void *modal, double x, double y, double width, double height);
// Clips the surface host to the rectangle x, y, width, height in its own bounds, top left origin, when clipped is true, and removes the
// clip when it is false: the host and every view in it, such as its native plane and the document regions there, draw only inside the
// rectangle. A window without a main page places a surface host at the box of its native view element and clips it to the part of the
// box that the element shows (docs/spec/native-surfaces.md#settings-seat). Call it on the main thread.
void sp_surface_set_clip(void *surface, bool clipped, double x, double y, double width, double height);
// Fills the surface host with the background color of its window when filled is true, and removes the fill when it is false. A window
// without a main page shows the surfaces below its settings window in the holes that it draws, so the host of the settings surface
// fills itself with the window background, which the workbench sets to the color of the pane (docs/spec/native-surfaces.md#settings-seat).
// Call it on the main thread.
void sp_surface_fill_window_background(void *surface, bool filled);
// Fills each surface host of window that fills itself with the window background again with the current background color of the
// window. Call it on the main thread after the background of the window changes.
void sp_window_fill_surface_backgrounds(void *window);
// Whether view is a surface host that sp_surface_create made. Call it on the main thread.
bool sp_surface_is_host(void *view);
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
// Window overlays as (x, y, w, h, cut) in the coordinates of the main web view: the main web view takes the native input in each
// rectangle, and the container of the surface hosts leaves out each rectangle whose cut is 1.
void sp_surface_set_window_overlays(void *mainWebview, const double *rects, size_t count);

// Native plane of the surface. Regions can be placed only below this view.
void *webviewSurfaceNativePlane(void *surface);
// With render, keeps the document of webview shown and its rendering and animation frames running while its window is
// occluded; without, gives the web view back the occlusion detection of WebKit, which hides the document of a web view in an
// occluded window and stops its rendering. The registered main web view, a view placed in a surface and a modal web view
// render, because a placement, a surface capture, a paint acknowledgement and the raise of a modal wait for their rendering,
// and a still capture of a covered window shows what they draw. A document region renders only while its window draws
// covered (sp_document_draw_covered), so a covered region throttles otherwise. Returns false when WebKit lacks the setting.
bool sp_webview_render_occluded(void *webview, bool render);
// Places the web view of a view in the surface below the native plane, so the overlay mask of the plane does not cut it
// and the regions of the view are drawn above it. The view renders while its window is occluded (sp_webview_render_occluded).
// Returns false when the surface has no host or the view cannot render while occluded.
bool sp_surface_place_view(void *surface, void *view);
// Gives the keyboard to the content view when the view or a view inside it holds it. A view calls this before it closes: AppKit
// keeps the view that held the keyboard when it leaves the window until the next change of the first responder, and a move to
// the window itself does not release a page of a surface.
void sp_view_give_up_keyboard(void *view);
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
// Gives the keyboard to a surface that declared an image region. Until the region shows, the surface itself holds the keyboard
// and keeps up to 256 keys, and the region receives them in order when it shows. The page does not see them.
void sp_surface_focus_for_region(void *surface);
// Gives the keyboard of window to the workbench: the registered main web view, or the view of the framework that draws the
// workbench of a window without a main web view. An open left press delays it as in sp_surface_focus.
void sp_window_focus_workbench(void *window);
// The workbench decided where the keyboard goes (docs/spec/native-surfaces.md#keyboard-of-a-surface): the keys of window that
// waited since the release of a left press on its workbench go in their order to the view that holds the keyboard after the
// keyboard calls before it, once no modal waits to take the keyboard. A window whose keys do not wait changes nothing.
void sp_window_keys_decided(void *window);
// The workbench of window ended: the process of its page exited, the page reloads or a new one starts. The keys that waited for its
// decision go as at sp_window_keys_decided. Harmless when nothing waits.
void sp_window_keys_page_ended(void *window);
// Lets the keys of window wait from the show of a modal web view until that view takes the keyboard
// (docs/spec/native-modals.md#keyboard), so a key pressed as the modal opens reaches the modal and not the view behind it. Only
// keys wait. While a modal waits or holds the keyboard, sp_surface_focus and sp_window_focus_workbench record their move and leave
// the keyboard where it is. An open modal wait stays as it is.
void sp_window_modal_hold(void *window);
// Ends the modal wait of window, after the modal web view took the keyboard or when the modal closed or failed before that. A modal
// that did not take the keyboard leaves it to the last recorded move. The keys go in their order to the view that holds the
// keyboard, once the decision of the workbench does not wait either. A window without a modal wait changes nothing.
void sp_window_modal_hold_end(void *window);
// Returns the keyboard of window to the last move that sp_surface_focus or sp_window_focus_workbench asked for, or to the workbench
// without one, when the modal web view closing closes. Returns false and changes nothing while another modal waits or holds the
// keyboard. closing may be NULL when the modal has left the window.
bool sp_window_keyboard_after_modal(void *window, void *closing);
// Records a move of the first responder of a window for the surfaces that it leaves and enters. The observation of the first
// responder calls it.
void sp_surface_responder_moved(void *from, void *to);
// Gives the keyboard to the surface that asked for it, now that its image region shows.
void sp_surface_region_shown(void *region);
// Gives the keyboard to an image region that a call asked to take it, after the release of an open press.
void sp_surface_region_focus(void *region);
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
#ifdef __OBJC__
@class NSView;
// Sets the hidden state of a view of a window. AppKit gives the keyboard to the window when a hide leaves the first responder in a
// hidden view, the hide of another view included; a surface that holds the keyboard for its region takes it back, so the keys typed
// while it waits reach that region (docs/spec/native-surfaces.md#keyboard-of-a-surface).
void sp_view_set_hidden(NSView *view, bool hidden);
#endif
