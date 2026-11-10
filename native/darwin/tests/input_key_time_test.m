// Checks the time of an injected key (docs/spec/exposure.md#virtual-key-window): NSEvent.timestamp, which a web view gives its
// key event as event.timeStamp, counts the uptime of the system. A named key without text (Enter) and a key with a stated text
// ("a") both carry the uptime of their injection, so the time between an injected key and what the page does with it is
// measured on one clock for both. The test process is never active, so its window takes keys as the virtual key window.
#import <Cocoa/Cocoa.h>
#import "input_inject.h"
#import "input_virtual.h"
#import "support/event_wait.h"

static int failures;
static void check(BOOL ok, NSString *message) {
    fprintf(ok ? stdout : stderr, "%s: %s\n", ok ? "PASS" : "FAIL", message.UTF8String);
    if (!ok) failures++;
}

// The first responder of the window. It keeps the timestamp of each key down by its key code.
@interface Clock : NSView
@property(retain) NSMutableDictionary<NSNumber *, NSNumber *> *downs;
@end
@implementation Clock
- (BOOL)acceptsFirstResponder { return YES; }
- (void)keyDown:(NSEvent *)event { self.downs[@(event.keyCode)] = @(event.timestamp); }
- (void)keyUp:(NSEvent *)event {}
- (void)dealloc { [_downs release]; [super dealloc]; }
@end

// The uptime read just before and just after the injection of a key down, and the timestamp of that key down.
typedef struct { NSTimeInterval before, after, time; BOOL received; } KeyTime;

// Injects key with text on window, presses it and releases it, and returns the uptime around its key down and the timestamp
// that the first responder received.
static KeyTime press(NSWindow *window, Clock *clock, const char *key, const char *text, unsigned short code) {
    KeyTime result = {0};
    result.before = NSProcessInfo.processInfo.systemUptime;
    BOOL down = sp_input_key(window, key, text, 0, true) == SP_INPUT_DELIVERED;
    result.after = NSProcessInfo.processInfo.systemUptime;
    BOOL up = sp_input_key(window, key, text, 0, false) == SP_INPUT_DELIVERED;
    check(down && up, [NSString stringWithFormat:@"the key %s is delivered", key]);
    if (down && up) {
        eventWait([NSString stringWithFormat:@"the key down of %s reaches the clock view", key], ^BOOL {
            return clock.downs[@(code)] != nil;
        });
    }
    NSNumber *time = clock.downs[@(code)];
    check(time != nil, [NSString stringWithFormat:@"the key %s reaches the first responder as a key down", key]);
    result.received = time != nil;
    result.time = time.doubleValue;
    return result;
}

static BOOL within(KeyTime time) { return time.received && time.before <= time.time && time.time <= time.after; }

static NSString *described(KeyTime time) {
    return [NSString stringWithFormat:@"(timestamp %.6f, uptime %.6f to %.6f)", time.time, time.before, time.after];
}

int main(void) { @autoreleasepool {
    setvbuf(stdout, NULL, _IOLBF, 0);
    [NSApplication sharedApplication];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 400, 300)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    Clock *clock = [[[Clock alloc] initWithFrame:window.contentView.bounds] autorelease];
    clock.downs = [NSMutableDictionary dictionary];
    [window.contentView addSubview:clock];
    check([window makeFirstResponder:clock], @"the clock view holds the keyboard of the window");

    // The named-key path: Enter without text. Its key code is 36.
    KeyTime named = press(window, clock, "Enter", NULL, 36);
    check(sp_input_virtual_is(window), @"the window of the key is the virtual key window");
    check(within(named), [@"the named key Enter carries the uptime of its injection " stringByAppendingString:described(named)]);
    // The stated-text path: "a" with the text "a". Its key code is 0.
    KeyTime stated = press(window, clock, "a", "a", 0);
    check(within(stated),
        [@"the key with a stated text a carries the uptime of its injection " stringByAppendingString:described(stated)]);

    [window close];
    [window release];
    return failures == 0 ? 0 : 1;
}}
