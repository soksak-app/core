#import <Cocoa/Cocoa.h>
#import "window_controls.h"
#import "private/appkit.h"

// AppKit 이 창 단추를 소유한다. 단추를 다른 뷰로 옮기면 AppKit 이 제목이나 녹화 표시가 바뀔 때
// (-[NSThemeFrame _updateButtons]) 되찾아 가고, 되돌리는 사이에 단추가 사라지거나 제목줄 자리로
// 당겨진 프레임이 화면에 나온다(측정: 창 이동·크기 변경 48회당 1~2 프레임). 대신 제목줄 높이를 정해
// AppKit 이 그 높이의 세로 가운데에 단추를 두게 한다.

// 제목줄을 가질 수 없는 창은 표준 단추나 콘텐츠 뷰가 없다.
static BOOL titled(NSWindow *window) {
    return [window standardWindowButton:NSWindowCloseButton] && window.contentView;
}

double windowTitlebarHeight(void *handle) {
    NSCAssert(NSThread.isMainThread, @"Window controls belong to the main thread");
    NSWindow *window = (NSWindow *)handle;
    // 0 은 제목줄이 없는 창(전체 화면)의 높이이므로 제목줄을 만들 수 없는 창은 -1 이다.
    if (!titled(window)) return -1;
    return window.frame.size.height - window.contentLayoutRect.size.height;
}

// AppKit 의 setTitlebarHeight: 는 SDK 헤더에 없다(docs/operations/private-native-apis.md). 0 이하의 값은
// 사용자 지정 높이를 지우지만 다시 배치하지 않으므로 받지 않는다. 전체 화면 전환은 들어갈 때 값을 저장하고
// 나올 때 되돌리므로, 전체 화면 동안 정한 값은 나올 때 사라진다. 그때는 거부하고 페이지가 나온 뒤에 다시 정한다.
bool windowSetTitlebarHeight(void *handle, double height, char **failure) {
    NSCAssert(NSThread.isMainThread, @"Window controls belong to the main thread");
    NSWindow *window = (NSWindow *)handle;
    *failure = NULL;
    if (!isfinite(height) || height <= 0) {
        *failure = strdup("title bar height must be a positive finite number");
        return false;
    }
    if (!titled(window)) {
        *failure = strdup("the window has no standard buttons or content view for a title bar");
        return false;
    }
    if (window.styleMask & NSWindowStyleMaskFullScreen) {
        *failure = strdup("the window shows no title bar in full screen");
        return false;
    }
    [window setTitlebarHeight:height];
    [window layoutIfNeeded];
    return true;
}

// 위치를 읽을 때 위치를 고치지 않는다. 호출자는 실제 geometry 가 필요하다.
void windowControls(void *handle, double *out) {
    NSCAssert(NSThread.isMainThread, @"Window controls belong to the main thread");
    NSWindow *window = (NSWindow *)handle;
    NSView *content = window.contentView;
    NSRect together = NSZeroRect;
    for (NSUInteger kind = NSWindowCloseButton; kind <= NSWindowZoomButton; kind++) {
        NSButton *button = [window standardWindowButton:kind];
        if (!button || button.isHiddenOrHasHiddenAncestor) continue;
        NSRect drawn = [button alignmentRectForFrame:button.bounds];
        NSRect at = [content convertRect:drawn fromView:button];
        together = NSIsEmptyRect(together) ? at : NSUnionRect(together, at);
    }
    if (NSIsEmptyRect(together)) return;
    out[0] = together.origin.x;
    out[1] = content.bounds.size.height - NSMaxY(together);
    out[2] = together.size.width;
    out[3] = together.size.height;
}
