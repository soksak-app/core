#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host-facing native operations retain their existing main-thread dispatch contract.
void *nativeWebviewCreate(uintptr_t window, unsigned long long identifier, const char *name, const char *script,
    double x, double y, double width, double height, bool hidden, bool transparent);
bool nativeWebviewNavigate(void *view, const char *url);
void nativeWebviewBounds(void *view, double x, double y, double width, double height);
// Runs the presentation callback after the view presented its next frame; false when the view is gone.
bool nativeWebviewAfterPresentation(void *view, uintptr_t callback);
void nativeWebviewHidden(void *view, bool hidden);
void nativeWebviewBackground(void *view, bool enabled);
void nativeWebviewEval(void *view, const char *script);
void nativeWebviewClose(void *view);
bool nativeWindowConfigureMain(uintptr_t window, bool dark);
bool nativeWindowSetMainWebview(uintptr_t window);
void *main_sp_window_main_webview(uintptr_t window);
bool main_sp_webview_collect_garbage(void *view);
void main_webviewGetFrame(void *view, double *out);
void main_view_retain(void *view);
void main_view_release(void *view);
void *main_sp_window_native_view(uintptr_t window);
void *main_sp_surface_create(uintptr_t window);
void main_sp_surface_close(void *surface);
void main_webviewSetFrame(void *view, double x, double y, double width, double height);
void main_sp_surface_focus(void *surface);
void main_sp_surface_focus_for_region(void *surface);
void main_sp_window_focus_workbench(uintptr_t window);
void main_sp_window_keys_decided(uintptr_t window);
void main_sp_window_keys_page_ended(uintptr_t window);
void main_sp_window_modal_hold(uintptr_t window);
void main_sp_window_modal_hold_end(uintptr_t window);
void main_webviewSetSurfaceHidden(void *view, bool hidden);
void main_webviewSetSurfaceAlpha(void *view, double alpha);
void main_sp_surface_set_window_overlays(void *main, const double *rects, size_t count);
void main_webviewSetSurfaceOverlays(void *view, const double *values, size_t count);
bool windowFileDrop(void *main, uintptr_t context);
void modalViewConfigure(void* handle, const char* title, double radius);
void modalViewFocus(void* handle, int take);
void modalAligned(uintptr_t parentWindow, double x, double y, double w, double h, double* out);
