// Shows a new window after its first screen is presented (window_reveal.h).
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "observe.h"
#import "window_facts.h"
#import "window_reveal.h"
#import "private/webkit.h"

// Observes loading of the main web view and makes the window opaque when the first load ends. After the
// window is revealed it ends the observation and releases itself.
@interface SPWindowReveal : NSObject {
    NSWindow *_window;
    WKWebView *_webview;
    BOOL _observing;
    BOOL _started;
}
- (instancetype)initWithWindow:(NSWindow *)window webview:(WKWebView *)webview;
@end

@implementation SPWindowReveal

- (instancetype)initWithWindow:(NSWindow *)window webview:(WKWebView *)webview {
    if ((self = [super init])) {
        _window = [window retain];
        _webview = [webview retain];
    }
    return self;
}

- (void)start {
    _observing = YES;
    // Initial also reports a load that already ended at registration.
    sp_observe_key_path("window_reveal.loading", SP_OBSERVE_RECORD, _webview, self, @"loading", NSKeyValueObservingOptionInitial, NULL);
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
    // Wait until a load starts. A load that already ended at registration still has its URL. A failed load
    // clears the URL when it ends, so the end is judged as an end that follows an observed start.
    sp_observe_delivered("window_reveal.loading");
    if (!_observing) return;
    if (_webview.loading) {
        _started = YES;
        return;
    }
    if (!_started && _webview.URL == nil) return;
    _observing = NO;
    [_webview removeObserver:self forKeyPath:@"loading"];
    [_webview _doAfterNextPresentationUpdate:^{
        self->_window.alphaValue = 1;
        [self release];
    }];
}

- (void)dealloc {
    [_window release];
    [_webview release];
    [super dealloc];
}

@end

bool sp_window_reveal_after_load(void *handle, char **error) {
    NSCAssert(NSThread.isMainThread, @"window reveal requires the UI thread");
    *error = NULL;
    NSWindow *window = (NSWindow *)handle;
    WKWebView *main = sp_window_main_webview(window);
    if (main == nil) {
        *error = strdup("window reveal needs a registered main webview");
        return false;
    }
    window.alphaValue = 0;
    // The observer releases itself when the window is revealed.
    [[[SPWindowReveal alloc] initWithWindow:window webview:main] start];
    return true;
}
