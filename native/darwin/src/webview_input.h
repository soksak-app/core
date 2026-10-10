#import <WebKit/WebKit.h>

// Main thread only. Returns NO when pointer tracking or pending-mouse handling is unavailable.
// The registration ends when webviewInputUnregister is called or the web view is released. Ending it
// removes the receipt message handler from the web view's user content controller, so the controller does
// not outlive the web view.
BOOL webviewInputRegister(WKWebView *view);
void webviewInputUnregister(WKWebView *view);

// Main thread only. Calls done(YES) when the document of view receives the next trusted DOM event of
// type ("pointerdown" or "pointerup") and calls done(NO) after timeout seconds. A script in a separate
// WebKit content world, which the page cannot see, reports the receipt. A view that is not registered
// has no receipt record and receives done(YES) immediately. Call it in the same main thread turn
// that delivers the event.
void webviewInputReceive(WKWebView *view, NSString *type, NSTimeInterval timeout, void (^done)(BOOL received));

// Registers the receipt wait before sending, then completes after the sent event is observed.
// Without the pending-mouse completion API on the registered view, done(NO) runs without sending; a
// missing receipt also gives done(NO).
void webviewInputSendThen(WKWebView *view, NSString *type, NSTimeInterval timeout,
    BOOL (^send)(void), void (^done)(BOOL received));


// Main thread only. The page of view cannot move the keyboard focus of the window by giving focus to an
// element. AppKit clicks and the host can still move it. Returns NO when the WebKit interface is
// unavailable.
BOOL webviewIgnorePageFocus(WKWebView *view);
