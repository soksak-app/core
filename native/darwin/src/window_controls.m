#import <Cocoa/Cocoa.h>
#import "window_controls.h"

// AppKit 이 창 단추를 소유한다. 단추를 다른 뷰로 옮기면 AppKit 이 제목이나 녹화 표시가 바뀔 때
// (-[NSThemeFrame _updateButtons]) 되찾아 가고, 되돌리는 사이에 단추가 사라지거나 제목줄 자리로
// 당겨진 프레임이 화면에 나온다(측정: 창 이동·크기 변경 48회당 1~2 프레임). 대신 제목줄을 도구막대
// 높이로 만들어 AppKit 이 그 높이의 세로 가운데에 단추를 두게 한다.
double windowUnifiedTitlebar(void *handle) {
    NSCAssert(NSThread.isMainThread, @"Window controls belong to the main thread");
    NSWindow *window = (NSWindow *)handle;
    if (![window standardWindowButton:NSWindowCloseButton] || !window.contentView) return 0;
    if (!window.toolbar) {
        NSToolbar *toolbar = [[[NSToolbar alloc] initWithIdentifier:@"soksak"] autorelease];
        // 항목이 없는 도구막대다. 제목줄 높이만 정하고 아무것도 그리지 않는다.
        toolbar.showsBaselineSeparator = NO;
        window.toolbar = toolbar;
    }
    window.toolbarStyle = NSWindowToolbarStyleUnifiedCompact;
    window.titlebarAppearsTransparent = YES;
    window.titleVisibility = NSWindowTitleHidden;
    [window layoutIfNeeded];
    return window.frame.size.height - window.contentLayoutRect.size.height;
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
