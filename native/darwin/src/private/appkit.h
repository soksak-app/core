// 이 라이브러리가 사용하는 AppKit 비공개 선언이다.
// 목록과 사용 조건: docs/operations/private-native-apis.md
#import <Cocoa/Cocoa.h>

@interface NSWindow (SPPrivate)
// 제목줄 높이(pt)를 정한다. -[NSThemeFrame setCustomTitlebarHeight:] 로 전달되고, AppKit 은 그 값으로
// 제목줄 높이, 콘텐츠 배치 영역과 창 단추 위치를 정한다. 0 이하는 사용자 지정 높이가 없다는 뜻이다.
- (void)setTitlebarHeight:(CGFloat)height;
@end
