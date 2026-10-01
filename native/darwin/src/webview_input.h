#import <WebKit/WebKit.h>

// 메인 스레드 전용이다. pointer tracking 이나 pending-mouse 처리를 사용할 수 없으면 NO 를 반환한다.
BOOL webviewInputRegister(WKWebView *view);
void webviewInputUnregister(WKWebView *view);

// 메인 스레드 전용이다. view 의 문서가 type("pointerdown" 또는 "pointerup")의 다음 trusted DOM
// 이벤트를 받으면 done(YES) 를 호출하고, timeout 초가 지나면 done(NO) 를 호출한다. 수신은
// 페이지가 볼 수 없는 별도 WebKit content world 의 스크립트가 보고한다. 등록되지 않은
// view 는 수신 기록이 없으며 즉시 done(YES) 를 받는다. 이벤트를 전달한 직후 같은
// 메인 스레드 turn 에서 호출한다.
void webviewInputReceive(WKWebView *view, NSString *type, NSTimeInterval timeout, void (^done)(BOOL received));

// 전송 전에 수신 대기를 등록하고 전송한 이벤트를 관측한 뒤 완료한다.
// 등록한 뷰의 처리 완료 API가 없으면 전송 없이 done(NO)이며 수신 후 부재도 done(NO)다.
void webviewInputSendThen(WKWebView *view, NSString *type, NSTimeInterval timeout,
    BOOL (^send)(void), void (^done)(BOOL received));


// 메인 스레드 전용이다. view 의 페이지는 요소에 focus 를 주어 창의 키보드 focus 를
// 옮길 수 없다. AppKit 클릭과 host 는 여전히 옮길 수 있다. WebKit 인터페이스를
// 사용할 수 없으면 NO 를 반환한다.
BOOL webviewIgnorePageFocus(WKWebView *view);
