// 새 창을 첫 화면이 표시된 뒤에 보인다(window_reveal.h).
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "window_facts.h"
#import "window_reveal.h"
#import "private/webkit.h"

// 메인 웹뷰의 loading 을 관찰하고 첫 읽기가 끝나면 창을 불투명하게 한다. 창을 드러낸 뒤 관찰을 끝내고
// 스스로를 해제한다.
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
    // Initial 은 등록할 때 이미 끝난 읽기도 알린다.
    [_webview addObserver:self forKeyPath:@"loading" options:NSKeyValueObservingOptionInitial context:NULL];
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
    // 읽기가 시작되기 전에는 기다린다. 등록할 때 이미 끝난 읽기는 URL 이 남아 있다. 실패한 읽기는 끝날 때 URL 을
    // 지우므로 시작을 본 뒤의 끝으로 판단한다.
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
    // 관찰 객체는 창을 드러낼 때 스스로를 해제한다.
    [[[SPWindowReveal alloc] initWithWindow:window webview:main] start];
    return true;
}
