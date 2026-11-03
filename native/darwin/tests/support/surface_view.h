// Places a view web view in a surface as the hosts do. A host makes the surface from the main web view with
// sp_surface_create, and sp_document_create places the view in it with sp_surface_place_view and then sets the page
// zoom and the device scale of the view. The caller sets the frame of the surface with webviewSetFrame and shows it with
// webviewSetSurfaceHidden, as the hosts do.
#import <WebKit/WebKit.h>
#import "private/webkit.h"
#import "webview_geometry.h"

static inline BOOL SPPlaceSurfaceView(void *surface, WKWebView *view) {
    if (!sp_surface_place_view(surface, view)) return NO;
    view.pageZoom = 1;
    [view _setOverrideDeviceScaleFactor:sp_surface_scale(surface)];
    return YES;
}
