#import <WebKit/WebKit.h>

// Main thread only. Returns NO if the required pointer-input API is unavailable.
BOOL webviewInputRegister(WKWebView *view);
void webviewInputUnregister(WKWebView *view);

// Main thread only. The page in view can no longer move the window's keyboard
// focus by focusing an element; AppKit clicks and the host still can. Returns NO
// if the WebKit interface is unavailable.
BOOL webviewIgnorePageFocus(WKWebView *view);
