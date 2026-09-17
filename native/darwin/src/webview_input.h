#import <WebKit/WebKit.h>

// Main thread only. Returns NO if the required pointer-input API is unavailable.
BOOL webviewInputRegister(WKWebView *view);
void webviewInputUnregister(WKWebView *view);
