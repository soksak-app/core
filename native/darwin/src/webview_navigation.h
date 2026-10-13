#include <stdbool.h>

#ifdef __OBJC__
#import <WebKit/WebKit.h>

// Each time the main frame of an app DOM web view changes to another document, opens the document in a new
// WebContent process and, once the document commits, clears the back/forward cache that holds the previous
// document paused, which ends the previous process. WebKit keeps a document replaced in the same process
// until memory pressure because of the per-document querySelectorAll result cache. It wraps the navigation
// delegate that the framework sets; that delegate receives every notification and decision unchanged, except that
// a WebContent process end arrives under the selector that the delegate implements, and the reason of the end is
// stored as the event native.webview.process_ended.
// Navigation within the same document (fragment) does not change the process. A web view that is already
// wrapped is not wrapped again. Call it on the main thread. Returns false when WebKit does not provide a
// required private selector.
bool sp_webview_replace_documents_in_new_process(WKWebView *view);
#endif
