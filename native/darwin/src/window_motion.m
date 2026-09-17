#import <Cocoa/Cocoa.h>
#import "window_motion.h"

void windowResizeInstant(void) {
    // AppKit 이 이 값을 처음 읽기 전에 등록해야 적용된다. 0 은 무시되어 기본 길이가 그대로
    // 쓰이므로(측정: 확대 뒤 내용이 약 400ms 늦음) 화면 갱신 한 번보다 짧은 값을 넣는다.
    // 등록 도메인에 넣으므로 사용자가 직접 설정한 값이 있으면 그 값이 우선한다.
    [NSUserDefaults.standardUserDefaults registerDefaults:@{@"NSWindowResizeTime": @0.001}];
}
