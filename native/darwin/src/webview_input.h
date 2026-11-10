#import <WebKit/WebKit.h>

// Main thread only. Returns NO when pointer tracking or pending-mouse handling is unavailable.
// The registration ends when webviewInputUnregister is called or the web view is released. Ending it
// removes the receipt message handler from the web view's user content controller, so the controller does
// not outlive the web view.
BOOL webviewInputRegister(WKWebView *view);
void webviewInputUnregister(WKWebView *view);

// Main thread only. Chooses the web view of the window that takes the pointer at event, as the local monitor does for an event that
// AppKit dispatches. A move that a caller delivers directly passes through here first.
void webviewInputRoutePointer(NSEvent *event);

// The way a send of webviewInputSendThen ended: the event was not sent, it reached the web view, or it reached another view.
typedef NS_ENUM(NSInteger, SPInputSend) {
    SPInputSendRefused = 0,
    SPInputSendDelivered = 1,
    SPInputSendElsewhere = 2,
};

// Main thread only. Calls ended once, with the text of the event, at the first end of view: the close of the window that view has now,
// the report of WebKit that the web process of view stopped answering, or the end of the input registration of view, which a view
// without one does not have. Returns the token that webviewInputForgetEnd stops; the token retains view until it fires or stops.
id webviewInputObserveEnd(WKWebView *view, void (^ended)(NSString *end));
void webviewInputForgetEnd(id token);

// The receipt waits of a registered web view have no limit (docs/spec/exposure.md#methods). A script in a separate WebKit content
// world, which the page cannot see, reports the receipt of each trusted pointerdown and pointerup. A wait ends once, by the first of
// these events: the receipt, which answers done(YES); the end of the handling by WebKit of the mouse events that it was given up to the
// event, after which a document that received the event has already reported it; the end of the input registration of the web view;
// the close of its window; the report of WebKit that the web process stopped answering; and, while the web view has an input context,
// which takes the event before the document and tells the host nothing, the next press or key event that the application receives
// instead of the end of the handling. Each end other than the receipt answers done(NO) and is recorded with the event that ended it.

// Main thread only. Waits for the receipt of the next trusted DOM event of type ("pointerdown" or "pointerup") of the document of view,
// whose event AppKit delivers in this turn, as a local monitor sees it before its view. A view that is not registered has no receipt
// record and receives done(YES) immediately.
void webviewInputReceiveThenDrain(WKWebView *view, NSString *type, void (^done)(BOOL received));
// Registers the receipt wait, lets the pending mouse work of WebKit end, sends, and completes at the receipt of the sent event: no later
// step of WebKit delays that answer. Without the pending-mouse completion API on the registered view, done(NO) runs without sending. A
// refused send and a send that reached another view answer done(NO) in the turn of the send.
void webviewInputSendThen(WKWebView *view, NSString *type, SPInputSend (^send)(void), void (^done)(BOOL received));


// Main thread only. The page of view cannot move the keyboard focus of the window by giving focus to an
// element. AppKit clicks and the host can still move it. Returns NO when the WebKit interface is
// unavailable.
BOOL webviewIgnorePageFocus(WKWebView *view);
