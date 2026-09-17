#import <WebKit/WebKit.h>

// Main thread only. Returns NO if the required pointer-input API is unavailable.
BOOL webviewInputRegister(WKWebView *view);
void webviewInputUnregister(WKWebView *view);

// Main thread only. Calls done(YES) once the document in view has received the next trusted DOM
// event of type ("pointerdown" or "pointerup"), or done(NO) after timeout seconds. The receipt is
// reported by a script in a separate WebKit content world, which the page cannot see. A view that
// is not registered has no receipts and gets done(YES) at once. Call it right after delivering
// the event, in the same main-thread turn.
void webviewInputReceive(WKWebView *view, NSString *type, NSTimeInterval timeout, void (^done)(BOOL received));

// Main thread only. The page in view can no longer move the window's keyboard
// focus by focusing an element; AppKit clicks and the host still can. Returns NO
// if the WebKit interface is unavailable.
BOOL webviewIgnorePageFocus(WKWebView *view);
