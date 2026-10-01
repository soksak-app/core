// 녹화 중 창이 커져도 마지막 프레임이 장치 픽셀 해상도로 창 전체를 담는지 실제 스트림으로 검사한다.
// 스트림 출력 크기는 시작할 때 정해지므로 따라가지 않으면 커진 창이 축소되어 기록된다.
// 애플리케이션을 활성화하지 않는다.
#import "../src/capture.m"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// 창 화면의 display link 콜백마다 다음 표시 목표 시각(ms, mach 절대 시각)을 기록한다.
@interface SPPresentation : NSObject
@property (nonatomic) int ticks;
@property (nonatomic) double target;
@end
@implementation SPPresentation
- (void)tick:(CADisplayLink *)link {
    self.ticks++;
    self.target = link.targetTimestamp * 1000;
}
@end

static void spin(NSTimeInterval seconds) {
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (until.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:
            [NSDate dateWithTimeIntervalSinceNow:MIN(0.01, until.timeIntervalSinceNow)]];
    }
}

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: native capture follows a growing window\n");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    NSWindow *window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(80, 80, 200, 100)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    window.backgroundColor = NSColor.redColor;
    [window orderFrontRegardless];
    BOOL (^onScreen)(void) = ^BOOL {
        NSArray *info = [(NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow,
            (CGWindowID)window.windowNumber) autorelease];
        return info.count == 1 && [info[0][(id)kCGWindowIsOnscreen] boolValue];
    };
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!onScreen() && deadline.timeIntervalSinceNow > 0) spin(0.01);
    check(onScreen(), @"the window server shows the capture window");
    // 첫 합성 프레임이 안정될 때까지 창을 바꾸지 않는다(capture_cycles_test 와 같다).
    spin(3);
    double scale = window.backingScaleFactor;

    // 바꾼 창은 다음 화면 갱신에 커밋되고 그 다음 갱신에 표시된다. 두 번째 display link 콜백의 목표
    // 시각(호스트의 host.window.presented 와 같은 기준)을 돌려준다.
    double (^presentedAfterChange)(void) = ^double {
        SPPresentation *presentation = [[SPPresentation new] autorelease];
        CADisplayLink *link = [window.contentView displayLinkWithTarget:presentation selector:@selector(tick:)];
        [link addToRunLoop:NSRunLoop.currentRunLoop forMode:NSDefaultRunLoopMode];
        NSDate *presented = [NSDate dateWithTimeIntervalSinceNow:10];
        while (presentation.ticks < 2 && presented.timeIntervalSinceNow > 0) spin(0.005);
        [link invalidate];
        check(presentation.ticks >= 2, [NSString stringWithFormat:@"the display link reports the next presentation (%d ticks)", presentation.ticks]);
        return presentation.target;
    };
    // 녹화의 index 번째(1부터) 프레임이 창 크기 points 를 장치 픽셀로 담는지 검사한다. 프레임 번호는 녹화 사이에
    // 이어지므로 디렉터리의 파일 순서로 고른다.
    BOOL (^frameIs)(NSString *, int, NSSize, NSString *) = ^BOOL(NSString *directory, int number, NSSize points, NSString *label) {
        NSArray *files = [[[NSFileManager defaultManager] contentsOfDirectoryAtPath:directory error:nil]
            sortedArrayUsingSelector:@selector(compare:)];
        NSString *path = number >= 1 && number <= (int)files.count
            ? [directory stringByAppendingPathComponent:files[number - 1]] : nil;
        NSData *stored = path ? [NSData dataWithContentsOfFile:path] : nil;
        if (stored.length < 68) {
            check(NO, [NSString stringWithFormat:@"%@: frame %d has a header", label, number]);
            return NO;
        }
        uint32_t head[3];
        double info[7];
        memcpy(head, stored.bytes, sizeof head);
        memcpy(info, (const uint8_t *)stored.bytes + sizeof head, sizeof info);
        uint32_t width = (uint32_t)llround(points.width * scale), height = (uint32_t)llround(points.height * scale);
        BOOL ok = head[0] == width && head[1] == height && info[4] == 1;
        check(ok, [NSString stringWithFormat:@"%@: frame %d records the window at device pixels "
            "(buffer %ux%u, content %.1fx%.1f at content scale %.4f; expected %ux%u at 1)",
            label, number, head[0], head[1], info[2], info[3], info[4], width, height]);
        return ok;
    };
    // 창을 녹화하는 동안 change 를 실행하고, 그 표시 뒤에 멈춘다. 프레임 수를 돌려주고 디렉터리는 directory 에 남긴다.
    int (^record)(NSString *, void (^)(void), NSString **) = ^int(NSString *label, void (^change)(void), NSString **directoryOut) {
        char template[] = "/tmp/soksak-capture-resize-XXXXXX";
        if (mkdtemp(template) == NULL) { check(NO, [NSString stringWithFormat:@"%@: the capture directory is created", label]); return 0; }
        NSString *directory = [NSString stringWithUTF8String:template];
        *directoryOut = directory;
        char *operationError = NULL;
        bool opened = sp_capture_open(window.windowNumber, false, &operationError);
        check(opened, [NSString stringWithFormat:@"%@: the window opens for recording (%s)", label, operationError ?: ""]);
        free(operationError); operationError = NULL;
        bool recording = opened && sp_capture_start(directory.fileSystemRepresentation, &operationError);
        check(recording, [NSString stringWithFormat:@"%@: recording starts (%s)", label, operationError ?: ""]);
        free(operationError);
        if (!recording) return 0;
        check(sp_capture_wait() == 1, [NSString stringWithFormat:@"%@: a first frame arrives (%s)", label, sp_capture_error()]);
        change();
        [window display];
        int frames = sp_capture_stop(presentedAfterChange());
        NSString *stopError = [NSString stringWithUTF8String:sp_capture_error()];
        check(stopError.length == 0 && frames > 0,
            [NSString stringWithFormat:@"%@: recording stops without error (frames %d, error %@)", label, frames, stopError]);
        return frames;
    };
    void (^remove)(NSString *) = ^(NSString *directory) {
        NSError *removal = nil;
        check(directory == nil || [[NSFileManager defaultManager] removeItemAtPath:directory error:&removal],
            [NSString stringWithFormat:@"capture files are removed (%@)", removal]);
    };

    // 녹화 중 창이 커지면 커진 창의 표시 뒤 마지막 프레임은 커진 창을 장치 픽셀로 담는다.
    NSString *directory = nil;
    int frames = record(@"growing", ^{
        [window setFrame:NSMakeRect(80, 80, 320, 160) display:YES];
        window.backgroundColor = NSColor.blueColor;
    }, &directory);
    if (frames > 0) frameIs(directory, frames, NSMakeSize(320, 160), @"growing");
    remove(directory);

    // 녹화 밖에서 줄인 창의 새 녹화는 첫 프레임부터 줄인 창의 크기다. 앞 녹화가 바꾼 출력 크기를 이어받지 않는다.
    [window setFrame:NSMakeRect(80, 80, 200, 100) display:YES];
    presentedAfterChange();
    directory = nil;
    frames = record(@"after shrinking", ^{ window.backgroundColor = NSColor.greenColor; }, &directory);
    if (frames > 0) {
        frameIs(directory, 1, NSMakeSize(200, 100), @"after shrinking");
        frameIs(directory, frames, NSMakeSize(200, 100), @"after shrinking");
    }
    remove(directory);
    check(!NSApp.isActive, @"recording does not activate the application");
    [window close];
    fprintf(stderr, "%s: native capture follows a growing window (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
