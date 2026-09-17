// 이 라이브러리가 사용하는 CoreGraphics 비공개 선언이다.
// 목록과 사용 조건: docs/operations/private-native-apis.md
#import <CoreGraphics/CoreGraphics.h>

// 이벤트가 속한 창 번호. +[NSEvent eventWithCGEvent:] 가 이 값으로 NSEvent.window 를 정한다.
static const CGEventField kSPEventWindowNumberField = (CGEventField)51;

// 창 왼쪽 위 기준 이벤트 좌표. +[NSEvent eventWithCGEvent:] 가 locationInWindow 로 쓴다.
extern void CGEventSetWindowLocation(CGEventRef event, CGPoint location);
