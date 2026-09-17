// 창 크기 변경 애니메이션 길이 검사. AppKit 이 기본값을 한 번 읽으므로, 등록한 프로세스와 등록하지
// 않은 프로세스를 따로 실행해 두 값을 비교한다. 애플리케이션을 활성화하지 않는다.
#import <Cocoa/Cocoa.h>
#import "window_motion.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// 창 하나를 화면 크기로 늘리는 데 AppKit 이 쓰는 시간(초).
static NSTimeInterval resizeTime(void) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 600, 400)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    NSTimeInterval took = [window animationResizeTime:NSMakeRect(0, 0, 1512, 901)];
    [window close];
    [window release];
    return took;
}

// 인자 mode 로 자신을 실행하고 그 프로세스가 출력한 시간을 반환한다.
static NSTimeInterval childTime(const char *program, const char *mode) {
    char command[1024];
    snprintf(command, sizeof(command), "%s %s", program, mode);
    FILE *child = popen(command, "r");
    if (!child) return -1;
    double took = -1;
    if (fscanf(child, "%lf", &took) != 1) took = -1;
    pclose(child);
    return took;
}

int main(int argc, const char *argv[]) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    if (argc > 1 && strcmp(argv[1], "instant") == 0) {
        windowResizeInstant();
        printf("%f\n", resizeTime());
        return 0;
    }
    if (argc > 1 && strcmp(argv[1], "plain") == 0) {
        printf("%f\n", resizeTime());
        return 0;
    }
    NSTimeInterval plain = childTime(argv[0], "plain");
    NSTimeInterval instant = childTime(argv[0], "instant");
    check(plain > 0.1, [NSString stringWithFormat:@"AppKit animates a window resize without the registered value (%.3fs)", plain]);
    // 한 화면 갱신(120Hz 에서 8.3ms)보다 짧아야 애니메이션이 한 걸음으로 끝난다.
    check(instant > 0 && instant < 0.008,
        [NSString stringWithFormat:@"the registered value shortens the resize below one display frame (%.3fs)", instant]);
    return failures ? 1 : 0;
}}
