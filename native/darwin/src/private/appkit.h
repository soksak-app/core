// 이 라이브러리가 사용하는 AppKit 비공개 선언이다.
// 목록과 사용 조건: docs/operations/private-native-apis.md
#import <Cocoa/Cocoa.h>

@interface NSTextInputContext (SPPrivate)
// 입력기(TSM) 이벤트를 텍스트 입력 클라이언트에 전달한다. 완료 블록은 형식을 선언하지 않고 그대로 넘긴다.
- (void)handleTSMEvent:(void *)event completionHandler:(id)completion;
@end
