// 이 라이브러리와 검사가 사용하는 WebKit 비공개 선언이다.
// 목록과 사용 조건: docs/operations/private-native-apis.md
#import <WebKit/WebKit.h>

@interface WKWebView (SPPrivate)
// WKWebViewPrivate.h
- (void)_setOverrideDeviceScaleFactor:(double)scale;
- (void)_doAfterNextPresentationUpdate:(void (^)(void))completion;
// WKWebViewPrivate.h (mac)
- (void)_setIgnoresMouseMoveEvents:(BOOL)ignore;
// WKWebViewPrivateForTesting.h
- (void)_doAfterActivityStateUpdate:(void (^)(void))completion;
- (void)_doAfterProcessingAllPendingMouseEvents:(void (^)(void))completion;
@end
