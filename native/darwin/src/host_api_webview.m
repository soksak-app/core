#include "host_api_webview.h"
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include "webview_geometry.h"
#include "window_facts.h"
#include "main_thread.h"
#include "host_callbacks.h"
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

// The native calls of this file run on the main thread (main_thread.h).
void *main_sp_window_main_webview(uintptr_t window) { return ON_MAIN(void *, sp_window_main_webview((void *)window)); }
bool main_sp_webview_collect_garbage(void *view) { return ON_MAIN(bool, sp_webview_collect_garbage(view)); }
void main_webviewGetFrame(void *view, double *out) { hostRunOnMain(^{ webviewGetFrame(view, out); }); }
void main_view_retain(void *view) { hostRunOnMain(^{ CFRetain(view); }); }
void main_view_release(void *view) { hostRunOnMain(^{ CFRelease(view); }); }
void *main_sp_window_native_view(uintptr_t window) { return ON_MAIN(void *, sp_window_native_view((void *)window)); }
void *main_sp_surface_create(uintptr_t window) { return ON_MAIN(void *, sp_surface_create(sp_window_composition((void *)window))); }
void main_sp_surface_close(void *surface) { hostRunOnMain(^{ sp_surface_close(surface); }); }
void main_webviewSetFrame(void *view, double x, double y, double width, double height) {
    hostRunOnMain(^{ webviewSetFrame(view, x, y, width, height); });
}
void main_sp_surface_focus(void *surface) { hostRunOnMain(^{ sp_surface_focus(surface); }); }
void main_sp_surface_focus_for_region(void *surface) { hostRunOnMain(^{ sp_surface_focus_for_region(surface); }); }
void main_sp_window_focus_workbench(uintptr_t window) { hostRunOnMain(^{ sp_window_focus_workbench((void *)window); }); }
void main_sp_window_keys_decided(uintptr_t window) { hostRunOnMain(^{ sp_window_keys_decided((void *)window); }); }
void main_sp_window_keys_page_ended(uintptr_t window) { hostRunOnMain(^{ sp_window_keys_page_ended((void *)window); }); }
void main_sp_window_modal_hold(uintptr_t window) { hostRunOnMain(^{ sp_window_modal_hold((void *)window); }); }
void main_sp_window_modal_hold_end(uintptr_t window) { hostRunOnMain(^{ sp_window_modal_hold_end((void *)window); }); }
void main_webviewSetSurfaceHidden(void *view, bool hidden) { hostRunOnMain(^{ webviewSetSurfaceHidden(view, hidden); }); }
void main_webviewSetSurfaceAlpha(void *view, double alpha) { hostRunOnMain(^{ webviewSetSurfaceAlpha(view, alpha); }); }
void main_sp_surface_set_window_overlays(void *main, const double *rects, size_t count) {
    hostRunOnMain(^{ sp_surface_set_window_overlays(main, rects, count); });
}
void main_webviewSetSurfaceOverlays(void *view, const double *values, size_t count) {
    hostRunOnMain(^{ webviewSetSurfaceOverlays(view, values, count); });
}

static void fileDroppedBridge(void *context, const char *json) {
    hostRunOnWorker(^{ sp_host_callback_file_dropped((uintptr_t)context, (char *)json); });
}

static void fileDropReleasedBridge(void *context) {
    hostRunOnWorker(^{ sp_host_callback_file_drop_released((uintptr_t)context); });
}

bool windowFileDrop(void *main, uintptr_t context) {
    return ON_MAIN(bool, sp_window_file_drop(main, fileDroppedBridge, fileDropReleasedBridge, (void *)context));
}

// A modal is a WKWebView inside the main window. A layer clips the corners, and the position and the focus of the modal
// do not change the OS window hierarchy.
static void modalViewConfigureOnMain(void* handle, const char* title, double radius) {
    NSView* view = (NSView*)handle;
    [view setWantsLayer:YES];
    view.layer.cornerRadius = radius;
    view.layer.masksToBounds = YES;
    if (title != NULL) [view setAccessibilityLabel:[NSString stringWithUTF8String:title]];
}

static void modalViewFocusOnMain(void* handle, int take) {
    NSView* view = (NSView*)handle;
    NSWindow* window = view.window;
    if (window == nil) return;
    if (take) {
        [view.superview addSubview:view positioned:NSWindowAbove relativeTo:nil];
        [window makeFirstResponder:view];
        return;
    }
    // The close of the modal returns the keyboard to the last move that the host asked for
    // (docs/spec/exposure.md#the-keyboard-follows-the-focus-ring).
    sp_window_keyboard_after_modal(window, view);
}

// Fits the modal region in page coordinates inward to the display pixel grid. Fitting outward would cover the border of the card,
// as with a surface. out holds five values: the fitted x, y, width and height, and the backing scale of the window whose device
// pixels the region was fitted to. A window that is gone writes nothing, so a caller that starts from zeros reads backing scale 0.
static void modalAlignedOnMain(void* parentWindow, double x, double y, double w, double h,
                         double* out) {
    NSWindow* parent = (NSWindow*)parentWindow;
    if (parent == nil) return;
    NSView* content = [parent contentView];
    if (content == nil) return;
    double up = content.bounds.size.height - y - h;
    NSRect r = [parent backingAlignedRect:NSMakeRect(x, up, w, h)
                                  options:NSAlignAllEdgesInward];
    out[0] = r.origin.x;
    out[1] = content.bounds.size.height - r.origin.y - r.size.height;
    out[2] = r.size.width;
    out[3] = r.size.height;
    out[4] = parent.backingScaleFactor;
}

void modalViewConfigure(void* handle, const char* title, double radius) {
    hostRunOnMain(^{ modalViewConfigureOnMain(handle, title, radius); });
}
void modalViewFocus(void* handle, int take) {
    hostRunOnMain(^{ modalViewFocusOnMain(handle, take); });
}
void modalAligned(uintptr_t parentWindow, double x, double y, double w, double h, double* out) {
    hostRunOnMain(^{ modalAlignedOnMain((void *)parentWindow, x, y, w, h, out); });
}
