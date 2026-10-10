// Checks the length of the window resize animation. AppKit reads the default once, so the check runs a registered
// process and an unregistered process separately and compares the two values. The check does not activate the
// application.
#import <Cocoa/Cocoa.h>
#import "window_motion.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// The time (seconds) that AppKit uses to expand one window to the screen size.
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

// Runs itself with the argument mode and returns the time that process printed.
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
    // It must be shorter than one display refresh (8.3ms at 120Hz) so that the animation ends in one step.
    check(instant > 0 && instant < 0.008,
        [NSString stringWithFormat:@"the registered value shortens the resize below one display frame (%.3fs)", instant]);
    return failures ? 1 : 0;
}}
