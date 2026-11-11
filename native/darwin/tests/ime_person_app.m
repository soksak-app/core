// The application of a person for input_virtual_ime_test: a separate process that takes the front, holds a composition of the
// input method in its text view, and reports the state of that view, so the test judges whether a key of the virtual key window
// of another application takes the composition of the person.
//
// Usage: ime_person_app <process identifier of the application to return the front to>
// Commands on standard input, one per line:
//   compose  types g and k of Korean 2-Set into its own key window through -[NSApplication sendEvent:], which composes 하
//   state    reports the state of the text view
//   quit     discards the composition, returns the front to the given application and exits
// The end of standard input, which the end of the test causes, quits in the same way. Each report is one JSON line on standard
// output: {"kind", "marked", "text", "source", "front"}; kind is ready, composed, state, or for a change of the text view by the
// input method mark, insert or unmark.
#import <Cocoa/Cocoa.h>
#import <Carbon/Carbon.h>
#include <stdlib.h>

static NSTextView *personView;
static pid_t returnTo;
static BOOL readyReported;

static NSString *currentSource(void) {
    TISInputSourceRef source = TISCopyCurrentKeyboardInputSource();
    if (!source) return @"";
    NSString *identifier = [[(NSString *)TISGetInputSourceProperty(source, kTISPropertyInputSourceID) copy] autorelease];
    CFRelease(source);
    return identifier ?: @"";
}

static void report(NSString *kind) {
    NSString *marked = personView.hasMarkedText ? [personView.string substringWithRange:personView.markedRange] : @"";
    NSDictionary *line = @{
        @"kind": kind,
        @"marked": marked,
        @"text": personView.string ?: @"",
        @"source": currentSource(),
        @"front": @(NSRunningApplication.currentApplication.isActive && personView.window.isKeyWindow),
    };
    NSData *json = [NSJSONSerialization dataWithJSONObject:line options:0 error:NULL];
    fwrite(json.bytes, 1, json.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

@interface SPPersonTextView : NSTextView
@end
@implementation SPPersonTextView
- (void)setMarkedText:(id)string selectedRange:(NSRange)selectedRange replacementRange:(NSRange)replacementRange {
    [super setMarkedText:string selectedRange:selectedRange replacementRange:replacementRange];
    report(@"mark");
}
- (void)insertText:(id)string replacementRange:(NSRange)replacementRange {
    [super insertText:string replacementRange:replacementRange];
    report(@"insert");
}
- (void)unmarkText {
    [super unmarkText];
    report(@"unmark");
}
@end

// A key of this application while it is in front, as the key of a person arrives: -[NSApplication sendEvent:] gives it to the
// key window, whose text view passes it to its input context.
static void sendKey(CGKeyCode code) {
    for (int down = 1; down >= 0; down--) {
        CGEventRef raw = CGEventCreateKeyboardEvent(NULL, code, down);
        if (!raw) continue;
        [NSApp sendEvent:[NSEvent eventWithCGEvent:raw]];
        CFRelease(raw);
    }
}

static void quit(void) {
    [personView.inputContext discardMarkedText];
    NSRunningApplication *previous = [NSRunningApplication runningApplicationWithProcessIdentifier:returnTo];
    if (previous) [previous activateWithOptions:0];
    exit(0);
}

static void reportReadyOnce(void) {
    if (readyReported || !NSRunningApplication.currentApplication.isActive || !personView.window.isKeyWindow) return;
    readyReported = YES;
    report(@"ready");
}

static void command(NSString *line) {
    if ([line isEqual:@"compose"]) {
        sendKey(5);   // g: ㅎ
        sendKey(40);  // k: ㅏ
        report(@"composed");
    } else if ([line isEqual:@"state"]) {
        report(@"state");
    } else if ([line isEqual:@"quit"]) {
        quit();
    }
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        returnTo = argc > 1 ? (pid_t)atoi(argv[1]) : 0;
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(200, 200, 360, 120)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        window.title = @"input_virtual_ime_test person";
        personView = [[SPPersonTextView alloc] initWithFrame:NSMakeRect(0, 0, 360, 120)];
        window.contentView = personView;
        [window makeFirstResponder:personView];
        NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
        [center addObserverForName:NSApplicationDidBecomeActiveNotification object:NSApp queue:nil
            usingBlock:^(NSNotification *note) { reportReadyOnce(); }];
        [center addObserverForName:NSWindowDidBecomeKeyNotification object:window queue:nil
            usingBlock:^(NSNotification *note) { reportReadyOnce(); }];
        NSMutableData *pending = [[NSMutableData alloc] init];
        NSFileHandle.fileHandleWithStandardInput.readabilityHandler = ^(NSFileHandle *handle) {
            NSData *data = handle.availableData;
            dispatch_async(dispatch_get_main_queue(), ^{
                if (data.length == 0) quit();
                [pending appendData:data];
                for (;;) {
                    NSRange end = [pending rangeOfData:[NSData dataWithBytes:"\n" length:1] options:0 range:NSMakeRange(0, pending.length)];
                    if (end.location == NSNotFound) break;
                    NSString *line = [[[NSString alloc] initWithData:[pending subdataWithRange:NSMakeRange(0, end.location)]
                        encoding:NSUTF8StringEncoding] autorelease];
                    [pending replaceBytesInRange:NSMakeRange(0, end.location + 1) withBytes:NULL length:0];
                    command(line);
                }
            });
        };
        [window makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
        dispatch_async(dispatch_get_main_queue(), ^{ reportReadyOnce(); });
        [NSApp run];
    }
    return 0;
}
