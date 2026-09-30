#import <WebKit/WebKit.h>

// Main thread only. Returns NO if pointer tracking or pending-mouse processing is unavailable.
BOOL webviewInputRegister(WKWebView *view);
void webviewInputUnregister(WKWebView *view);

// Main thread only. Calls done(YES) once the document in view has received the next trusted DOM
// event of type ("pointerdown" or "pointerup"), or done(NO) after timeout seconds. The receipt is
// reported by a script in a separate WebKit content world, which the page cannot see. A view that
// is not registered has no receipts and gets done(YES) at once. Call it right after delivering
// the event, in the same main-thread turn.
void webviewInputReceive(WKWebView *view, NSString *type, NSTimeInterval timeout, void (^done)(BOOL received));

// 전송 전에 수신 대기를 등록하고 전송한 이벤트를 관측한 뒤 완료한다.
// 등록한 뷰의 처리 완료 API가 없으면 전송 없이 done(NO)이며 수신 후 부재도 done(NO)다.
void webviewInputSendThen(WKWebView *view, NSString *type, NSTimeInterval timeout,
    BOOL (^send)(void), void (^done)(BOOL received));


// Main thread only. The page in view can no longer move the window's keyboard
// focus by focusing an element; AppKit clicks and the host still can. Returns NO
// if the WebKit interface is unavailable.
BOOL webviewIgnorePageFocus(WKWebView *view);
