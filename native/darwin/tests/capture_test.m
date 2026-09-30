#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import "capture.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: native capture acceptance\n");
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
    // The recording target stays unchanged long enough for its initial compositor frame to become idle.
    NSDate *settled = [NSDate dateWithTimeIntervalSinceNow:3];
    while (settled.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:
            [NSDate dateWithTimeIntervalSinceNow:MIN(0.01, settled.timeIntervalSinceNow)]];
    }
    check(sp_capture_open(window.windowNumber, false), @"a visible inactive window opens for recording");
    bool recordingStarted = sp_capture_start(directory);
    check(recordingStarted, [NSString stringWithFormat:@"recording starts on an unchanged inactive window (%@)",
        [NSString stringWithUTF8String:sp_capture_error()]]);
    if (recordingStarted) {
        int firstFrame = sp_capture_wait();
        check(firstFrame == 1, [NSString stringWithFormat:@"an unchanged inactive window produces a first frame (%@)",
            [NSString stringWithUTF8String:sp_capture_error()]]);
        int frames = sp_capture_stop(0);
        const char *stopError = sp_capture_error();
        check(stopError != NULL && strlen(stopError) == 0,
            [NSString stringWithFormat:@"recording stops without error (%s)", stopError]);
        check(frames > 0, [NSString stringWithFormat:@"recording writes a complete frame (got %d)", frames]);
        // 정지 이미지와 녹화 모두 창의 장치 픽셀 크기를 보존한다.
        NSString *first = [[NSString stringWithUTF8String:directory] stringByAppendingPathComponent:@"frame-0001.bgra"];
        NSData *recorded = [NSData dataWithContentsOfFile:first];
        uint32_t dimensions[3] = {0, 0, 0};
        if (recorded.length >= sizeof(dimensions)) [recorded getBytes:dimensions length:sizeof(dimensions)];
        check(recorded.length >= sizeof(dimensions) && dimensions[0] == (uint32_t)(200 * scale)
            && dimensions[1] == (uint32_t)(100 * scale),
            [NSString stringWithFormat:@"the recording has the window's device-pixel size (got %ux%u, expected %.0fx%.0f at scale %.1f)",
                dimensions[0], dimensions[1], 200 * scale, 100 * scale, scale]);
        uint64_t header = sizeof(dimensions) + 7 * sizeof(double);
        uint64_t payload = (uint64_t)dimensions[2] * dimensions[1];
        check(dimensions[0] > 0 && dimensions[1] > 0 && dimensions[2] >= (uint64_t)dimensions[0] * 4
            && recorded.length >= header && recorded.length == header + payload,
            [NSString stringWithFormat:@"the recording contains complete metadata and BGRA bytes (got %lu, expected %llu)",
                (unsigned long)recorded.length, (unsigned long long)(header + payload)]);
    }
    check(!NSApp.isActive, @"recording an unchanged window does not activate the application");
    [window close];
    [window release];
    [[NSFileManager defaultManager] removeItemAtPath:[NSString stringWithUTF8String:directory] error:NULL];
    fprintf(stderr, "%s: native capture acceptance (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
