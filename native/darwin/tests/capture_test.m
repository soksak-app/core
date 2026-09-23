#import <Cocoa/Cocoa.h>
#import "capture.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    char directory[] = "/tmp/soksak-capture-test-XXXXXX";
    check(mkdtemp(directory) != NULL, @"a private capture directory is created");
    check(!sp_capture_open(-1, false), @"an invalid window is rejected by the native capture boundary");
    check(sp_capture_error() != NULL && strlen(sp_capture_error()) > 0, @"open failure is observable to the caller");
    check(!sp_capture_start(directory), @"starting without a capture target is rejected");
    check(sp_capture_error() != NULL && strlen(sp_capture_error()) > 0, @"start failure is observable to the caller");
    check(sp_capture_wait() == 0, @"an invalid window cannot produce a capture frame");
    check(sp_capture_stop(0) == 0, @"stopping an invalid capture reports no written frames");
    NSArray *files = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:
        [NSString stringWithUTF8String:directory] error:NULL];
    check(files.count == 0, @"an invalid capture leaves no frame files");
    // 정지 캡처: 활성화하지 않은 창을 PNG 로 찍는다. 관측 자료이며 크기와 색으로 내용을 확인한다.
    NSString *still = [[NSString stringWithUTF8String:directory] stringByAppendingPathComponent:@"still.png"];
    check(!sp_capture_still(-1, still.UTF8String) && strlen(sp_capture_error()) > 0,
        @"a still capture of a missing window reports an error");
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 200, 100)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    // 나타나는 애니메이션 도중의 창은 작은 사각형으로 합성된다.
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    window.backgroundColor = [NSColor colorWithSRGBRed:1 green:0 blue:0 alpha:1];
    // 앱을 활성화하지 않고 창을 앞에 둔다. 가림 상태가 보임이 되면 윈도 서버가 합성한 것이다.
    [window orderFrontRegardless];
    // 윈도 서버가 창을 화면에 올린 뒤 찍는다. 올리기 전의 창은 화면 사각형이 없다. 다른 창에 가려져 있어도 된다.
    BOOL (^onScreen)(void) = ^BOOL {
        NSArray *info = [(NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow,
            (CGWindowID)window.windowNumber) autorelease];
        return info.count == 1 && [info[0][(id)kCGWindowIsOnscreen] boolValue];
    };
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!onScreen() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    check(onScreen(), @"the window server shows the capture window");
    bool stillWritten = sp_capture_still(window.windowNumber, still.UTF8String);
    check(stillWritten, [NSString stringWithFormat:@"a still capture of an inactive window is written (%@)",
        [NSString stringWithUTF8String:sp_capture_error()]]);
    NSBitmapImageRep *image = [NSBitmapImageRep imageRepWithData:[NSData dataWithContentsOfFile:still]];
    CGFloat scale = window.backingScaleFactor;
    check(image != nil && image.pixelsWide == (NSInteger)(200 * scale) && image.pixelsHigh == (NSInteger)(100 * scale),
        [NSString stringWithFormat:@"the still image has the window's device-pixel size (got %ldx%ld)",
            (long)image.pixelsWide, (long)image.pixelsHigh]);
    NSColor *centre = [[image colorAtX:image.pixelsWide / 2 y:image.pixelsHigh / 2] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    check(centre.redComponent > 0.9 && centre.greenComponent < 0.3 && centre.blueComponent < 0.1,
        [NSString stringWithFormat:@"the still image shows the window content (centre %@)", centre]);
    check(!NSApp.isActive, @"the still capture does not activate the application");
    [window close];
    [window release];
    [[NSFileManager defaultManager] removeItemAtPath:[NSString stringWithUTF8String:directory] error:NULL];
    return failures ? 1 : 0;
}}
