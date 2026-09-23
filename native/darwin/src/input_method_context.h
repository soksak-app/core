// 입력기 이벤트를 전달하는 동안을 알려 주는 텍스트 입력 컨텍스트.
//
// 입력기는 TSM 이벤트로 문자열을 넣고, 입력기가 처리하지 않은 키의 문자열은 키 바인딩이 넣는다.
// 두 경로 모두 insertText:replacementRange: 를 부르므로 클라이언트는 이 컨텍스트로 출처를 구별한다.
#import <Cocoa/Cocoa.h>

@interface SPInputMethodContext : NSTextInputContext
// 입력기 이벤트를 전달하는 중이면 YES.
@property(readonly) BOOL handlingInputMethodEvent;
// AppKit 이 입력기 이벤트를 전달하는 선택자를 가지면 YES. 없으면 출처를 구별할 수 없다.
+ (BOOL)observesInputMethodEvents;
// event 를 입력기 이벤트로 실행한다. AppKit 의 입력기 이벤트와 검사의 입력기 호출이 이 경로를 쓴다.
- (void)performInputMethodEvent:(void (^)(void))event;
@end
