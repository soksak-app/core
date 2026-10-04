// 창의 배치 트랜잭션(surfaceLayoutBegin)이 열린 동안 바꾼 제목줄 높이가 커밋 전에는 화면에 나오지 않고
// 커밋 뒤에 나오는지 윈도 서버가 보여 준 창 녹화로 검사한다. 페이지는 새 첫 행을 그리는 프레임의
// 트랜잭션에서 제목줄 높이를 바꾸므로, 창 단추가 그 커밋과 같은 프레임에 옮겨져야 한다.
// 애플리케이션을 활성화하지 않는다.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import "surface_layout.h"
#import "window_controls.h"
#import "capture.h"
#import "support/capture_frame.m"

// 트랜잭션이 열린 동안과 커밋 뒤에 기다리는 화면 갱신 수.
static const int kRefreshes = 12;

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// 콜백 타임아웃으로 프로세스가 종료돼도 녹화 파일을 남기지 않는다.
static NSString *recordingDirectory;
static void cleanupRecording(void) {
    if (recordingDirectory == nil) return;
    NSError *error = nil;
    if (![[NSFileManager defaultManager] removeItemAtPath:recordingDirectory error:&error])
        fprintf(stderr, "FAIL: title bar recording cleanup: %s\n", error.localizedDescription.UTF8String);
    [recordingDirectory release]; recordingDirectory = nil;
}

static void until(BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                               beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    if (!done()) { fprintf(stderr, "FAIL: the display did not refresh within 10 seconds\n"); exit(1); }
}

// 화면 갱신을 정해진 수만큼 센다.
@interface SPFrames : NSObject
@property int left;
- (void)tick:(CADisplayLink *)link;
@end
@implementation SPFrames
- (void)tick:(CADisplayLink *)link {
    if (--self.left == 0) [link invalidate];
}
@end

// 화면 갱신 count 번 동안 실행 루프를 돌린다. AppKit 의 배치·표시 주기도 그동안 실행된다.
// 걸린 시간(ms)을 반환한다.
static double waitFrames(NSScreen *screen, int count) {
    double start = CACurrentMediaTime() * 1000;
    SPFrames *frames = [[SPFrames new] autorelease];
    frames.left = count;
    [[screen displayLinkWithTarget:frames selector:@selector(tick:)]
        addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    until(^BOOL { return frames.left == 0; });
    return CACurrentMediaTime() * 1000 - start;
}

// 두 호스트의 창과 같이 제목 표시줄을 숨기고 콘텐츠가 창 전체를 차지하는 창. 도구막대는 없다.
// 콘텐츠는 한 색으로 칠해 단추만 다른 색으로 남게 한다.
static NSWindow *hostLikeWindow(void) {
    NSWindow *window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(140, 140, 480, 240)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable
            | NSWindowStyleMaskResizable | NSWindowStyleMaskFullSizeContentView
        backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    window.titlebarAppearsTransparent = YES;
    window.titleVisibility = NSWindowTitleHidden;
    NSView *content = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 480, 240)] autorelease];
    content.wantsLayer = YES;
    content.layer.backgroundColor = [NSColor colorWithSRGBRed:30.0/255 green:60.0/255 blue:200.0/255 alpha:1].CGColor;
    window.contentView = content;
    return window;
}

static bool setHeight(NSWindow *window, double height) {
    char *failure = NULL;
    bool set = windowSetTitlebarHeight(window, height, &failure);
    if (!set) fprintf(stderr, "windowSetTitlebarHeight(%.1f): %s\n", height, failure);
    free(failure);
    return set;
}

// 모델 값: windowControls 의 단추 영역 가운데(콘텐츠 위 기준 pt), 닫기 단추 레이어의 모델 프레임과
// presentationLayer 프레임.
static NSString *modelValues(NSWindow *window) {
    double area[4] = {0, 0, 0, 0};
    windowControls(window, area);
    NSButton *close = [window standardWindowButton:NSWindowCloseButton];
    CALayer *layer = close.layer;
    NSString *layers = @"no layer";
    if (layer) {
        CALayer *shown = layer.presentationLayer;
        layers = [NSString stringWithFormat:@"layer %@, presentation %@", NSStringFromRect(NSRectFromCGRect(layer.frame)),
            shown ? NSStringFromRect(NSRectFromCGRect(shown.frame)) : @"none"];
    }
    return [NSString stringWithFormat:@"title bar %.1f, buttons centre %.2f, close frame %@, %@",
        windowTitlebarHeight(window), area[1] + area[3] / 2, NSStringFromRect(close.frame), layers];
}

static double buttonsCentre(NSWindow *window) {
    double area[4] = {0, 0, 0, 0};
    windowControls(window, area);
    return area[1] + area[3] / 2;
}

// 녹화 프레임 하나에서 창 단추가 차지한 행의 가운데(창 위 기준 pt)를 잰다. 콘텐츠 색과 다른 화소가 있는
// 첫 행과 마지막 행의 가운데다. 창 테두리와 둥근 모서리를 피해 왼쪽 위 6pt 를 건너뛴다. 단추가 없으면 NAN.
static double measuredCentre(NSData *data, double *displayed) {
    uint32_t head[3] = {0}; double info[7] = {0};
    if (data.length < sizeof(head) + sizeof(info)) return NAN;
    [data getBytes:head length:sizeof(head)];
    [data getBytes:info range:NSMakeRange(sizeof(head), sizeof(info))];
    if (!(head[0] > 0 && head[1] > 0 && head[2] >= head[0] * 4 &&
          data.length == sizeof(head) + sizeof(info) + (size_t)head[2] * head[1] && info[4] > 0 && info[5] > 0))
        return NAN;
    *displayed = info[6];
    const uint8_t *pixels = (const uint8_t *)data.bytes + sizeof(head) + sizeof(info);
    double scale = info[4] * info[5];
    // 콘텐츠 색은 단추가 없는 곳(창 위 100pt, 왼쪽 300pt)에서 읽는다.
    size_t bx = (size_t)floor((info[0] + 300) * scale), by = (size_t)floor((info[1] + 100) * scale);
    if (bx >= head[0] || by >= head[1]) return NAN;
    const uint8_t *background = pixels + by * head[2] + bx * 4;
    long top = (long)floor(info[1] * scale);
    long first = -1, last = -1;
    for (long y = (long)floor((info[1] + 6) * scale); y < (long)floor((info[1] + 120) * scale) && y < (long)head[1]; y++) {
        for (long x = (long)floor((info[0] + 6) * scale); x < (long)floor((info[0] + 90) * scale) && x < (long)head[0]; x++) {
            const uint8_t *p = pixels + (size_t)y * head[2] + (size_t)x * 4;
            if (abs((int)p[0] - background[0]) > 40 || abs((int)p[1] - background[1]) > 40 ||
                abs((int)p[2] - background[2]) > 40) {
                if (first < 0) first = y;
                last = y;
                break;
            }
        }
    }
    if (first < 0) return NAN;
    return ((first - top) + (last - top) + 1) / 2.0 / scale;
}

// 바꾼 제목줄 높이(height), 바꾼 시각(set)과 커밋 시각(committed), 바꾸기 전과 뒤의 단추 가운데(from, to).
typedef struct { double height; double set; double committed; double from; double to; } SPChange;

// 트랜잭션을 열고 제목줄을 to 로 바꾼 뒤 kRefreshes 번의 화면 갱신 동안 커밋하지 않고, 그 뒤에 커밋한다.
static SPChange change(NSWindow *window, uint64_t ticket, double to) {
    SPChange result = { to, 0, 0, buttonsCentre(window), 0 };
    __block BOOL allowed = NO;
    surfaceLayoutBegin(window, ticket, ^(int ready) { allowed = ready; });
    check(allowed, [NSString stringWithFormat:@"the layout transaction %llu starts", ticket]);
    fprintf(stdout, "model before %.1fpt: %s\n", to, modelValues(window).UTF8String);
    result.set = CACurrentMediaTime() * 1000;
    check(setHeight(window, to), [NSString stringWithFormat:@"the title bar takes %.1fpt inside the open transaction", to]);
    result.to = buttonsCentre(window);
    fprintf(stdout, "model after setting %.1fpt in the open transaction: %s\n", to, modelValues(window).UTF8String);
    double waited = waitFrames(window.screen, kRefreshes);
    fprintf(stdout, "model after %d refreshes (%.1fms) in the open transaction: %s\n",
        kRefreshes, waited, modelValues(window).UTF8String);
    result.committed = CACurrentMediaTime() * 1000;
    check(surfaceLayoutCommit(window, ticket), [NSString stringWithFormat:@"the layout transaction %llu commits", ticket]);
    waited = waitFrames(window.screen, kRefreshes);
    fprintf(stdout, "model after %d refreshes (%.1fms) after the commit: %s\n",
        kRefreshes, waited, modelValues(window).UTF8String);
    return result;
}

// 녹화 프레임을 표시 시각 순서로 바꿈마다 판정한다. 제목줄을 바꾼 뒤 커밋 전에 표시된 프레임은 모두 이전
// 자리이고, 커밋 뒤 다음 바꿈 전의 마지막 프레임은 새 자리이며, 새 자리가 나온 뒤 이전 자리로 돌아가지 않는다.
static void judge(NSString *directory, int count, const SPChange *changes, int total) {
    double centres[count], shown[count];
    for (int index = 0; index < count; index++) {
        NSString *path = [directory stringByAppendingPathComponent:
            [NSString stringWithFormat:@"frame-%04d.bgra", index + 1]];
        NSData *data = readCaptureFrame([NSData dataWithContentsOfFile:path]);
        shown[index] = NAN;
        centres[index] = data ? measuredCentre(data, &shown[index]) : NAN;
        check(!isnan(centres[index]) && !isnan(shown[index]), [NSString stringWithFormat:
            @"frame %d/%d shows the window buttons (centre %.2fpt, display %.3f)", index + 1, count, centres[index], shown[index]]);
    }
    for (int c = 0; c < total; c++) {
        const SPChange *at = &changes[c];
        double next = c + 1 < total ? changes[c + 1].set : INFINITY;
        int held = 0, after = 0, lastAfter = -1;
        BOOL moved = NO, returned = NO;
        double firstNew = NAN;
        for (int index = 0; index < count; index++) {
            if (isnan(centres[index])) continue;
            BOOL old = fabs(centres[index] - at->from) <= 0.5;
            BOOL new = fabs(centres[index] - at->to) <= 0.5;
            if (shown[index] >= at->set && shown[index] < at->committed) {
                held++;
                check(old, [NSString stringWithFormat:@"%.1fpt title bar: frame %d displayed %.1fms after the change and "
                    "%.1fms before the commit keeps the buttons at %.2fpt (measured %.2fpt)",
                    at->height, index + 1, shown[index] - at->set, at->committed - shown[index], at->from, centres[index]]);
            } else if (shown[index] >= at->committed && shown[index] < next) {
                after++;
                lastAfter = index;
                check(old || new, [NSString stringWithFormat:@"%.1fpt title bar: frame %d after the commit shows the buttons at "
                    "%.2fpt or %.2fpt (measured %.2fpt)", at->height, index + 1, at->from, at->to, centres[index]]);
                if (new && !moved) firstNew = shown[index] - at->committed;
                if (new) moved = YES;
                else if (moved) returned = YES;
            }
        }
        fprintf(stdout, "%.1fpt title bar: %d frames between the change and the commit, %d frames after the commit, "
            "first new frame %.1fms after the commit\n", at->height, held, after, firstNew);
        // 커밋 전 프레임이 없으면 화면에 나오지 않았다는 관측이 아니다.
        check(held > 0, [NSString stringWithFormat:@"%.1fpt title bar: the recording has frames displayed while the "
            "transaction is open (%d)", at->height, held]);
        check(lastAfter >= 0 && fabs(centres[lastAfter] - at->to) <= 0.5 && !returned, [NSString stringWithFormat:
            @"%.1fpt title bar: the buttons reach %.2fpt after the commit and stay (last frame %.2fpt)",
            at->height, at->to, lastAfter >= 0 ? centres[lastAfter] : NAN]);
    }
}

int main(void) { @autoreleasepool {
    atexit(cleanupRecording);
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = hostLikeWindow();
    check(setHeight(window, 40), @"the window starts with a 40pt title bar");
    [window orderFrontRegardless];
    waitFrames(window.screen, kRefreshes);

    char directory[] = "/tmp/soksak-titlebar-test-XXXXXX";
    BOOL created = mkdtemp(directory) != NULL;
    check(created, @"the title bar recording directory is created");
    if (!created) { [window close]; return 1; }
    recordingDirectory = [[NSString stringWithUTF8String:directory] copy];
    char *operationError = NULL;
    BOOL opened = sp_capture_open(window.windowNumber, false, &operationError);
    BOOL started = NO;
    if (opened) { free(operationError); operationError = NULL; started = sp_capture_start(directory, &operationError); }
    check(started, [NSString stringWithFormat:@"the title bar recording starts (%s)", operationError == NULL ? "" : operationError]);
    free(operationError);
    if (started) {
        check(sp_capture_wait() > 0, @"the title bar recording contains its initial frame");
        // 높이는 프레임 글자 배율 1 과 2 의 첫 행이다. 올렸다가 내린다.
        SPChange changes[2];
        changes[0] = change(window, 201, 80);
        changes[1] = change(window, 202, 40);
        int count = sp_capture_stop(CACurrentMediaTime() * 1000);
        const char *recordingError = sp_capture_error();
        check(recordingError[0] == 0 && !sp_capture_limited(), [NSString stringWithFormat:
            @"the title bar recording ends without error or truncation (%s)", recordingError[0] ? recordingError : "none"]);
        check(count >= 3, [NSString stringWithFormat:@"the title bar recording has frames for both changes (%d)", count]);
        fprintf(stdout, "recording: %d frames, longest gap %.1fms\n", count, sp_capture_longest_gap());
        judge(recordingDirectory, count, changes, 2);
    }
    cleanupRecording();
    [window close];
    return failures ? 1 : 0;
}}
