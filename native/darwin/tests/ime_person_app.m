// The application of a person for input_virtual_ime_test: a separate process that takes the front with a window that shows nothing
// and lets every click pass, holds a composition of the
// input method in its text view, and reports the state of that view, so the test judges whether a key of the virtual key window
// of another application takes the composition of the person.
//
// Usage: ime_person_app <process identifier of the application to return the front to>
// Commands on standard input, one per line:
//   compose   ends any composition with Escape, empties the text view, and types g and k of Korean 2-Set into its own key window
//             through -[NSApplication sendEvent:], which composes 하
//   continue  types s the same way, which continues a composition of 하 that the input method still holds into 한, and appends ㄴ
//             to a 하 that it no longer holds
//   state     reports the state of the text view
//   quit     discards the composition, returns the front to the given application and exits
// The end of standard input, which the end of the test causes, quits in the same way. Each report is one JSON line on standard
// output: {"kind", "marked", "text", "source", "front", "alpha", "current"}, where current states whether the input context of the
// text view is the current input context of the application; kind is ready, composed, continued, state, or for a change of the text
// view by the input method mark, insert or unmark. A change also names the replaced range, "range". The reports composed and continued
// also name, as "keys", the CGEvent field 76 and the synthesized flag of each key event, by which -[NSTextInputContext handleEvent:]
// tells a key of a person from a made one.
// The Korean 2-Set input method of macOS composes in a text view without marked text: it inserts ㅎ and then 하 in place of ㅎ, and
// keeps the composition itself. So the text of the view, not its marked text, shows the composition.
#import <Cocoa/Cocoa.h>
#import <Carbon/Carbon.h>
#import <objc/message.h>
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

static void report(NSString *kind, NSDictionary *extra) {
    NSString *marked = personView.hasMarkedText ? [personView.string substringWithRange:personView.markedRange] : @"";
    NSDictionary *line = @{
        @"kind": kind,
        @"marked": marked,
        @"text": personView.string ?: @"",
        @"source": currentSource(),
        @"front": @(NSRunningApplication.currentApplication.isActive && personView.window.isKeyWindow),
        @"alpha": @(personView.window.alphaValue),
        @"current": @(NSTextInputContext.currentInputContext == personView.inputContext),
    };
    if (extra) {
        NSMutableDictionary *joined = [[line mutableCopy] autorelease];
        [joined addEntriesFromDictionary:extra];
        line = joined;
    }
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
    report(@"mark", @{@"range": NSStringFromRange(replacementRange)});
}
- (void)insertText:(id)string replacementRange:(NSRange)replacementRange {
    [super insertText:string replacementRange:replacementRange];
    report(@"insert", @{@"range": NSStringFromRange(replacementRange)});
}
- (void)unmarkText {
    [super unmarkText];
    report(@"unmark", nil);
}
// Escape that the input method passes on asks the text view for completions, whose panel this application does not open.
- (void)doCommandBySelector:(SEL)selector {
    if (selector == @selector(cancelOperation:) || selector == @selector(complete:)) return;
    [super doCommandBySelector:selector];
}
@end

// A key of this application while it is in front, as the key of a person arrives: -[NSApplication sendEvent:] gives it to the
// key window, whose text view passes it to its input context.
// Returns, per key event, its CGEvent field 76 and whether AppKit counts it as synthesized.
static NSArray *sendKey(CGKeyCode code) {
    NSMutableArray *kinds = [NSMutableArray array];
    for (int down = 1; down >= 0; down--) {
        CGEventRef raw = CGEventCreateKeyboardEvent(NULL, code, down);
        if (!raw) continue;
        NSEvent *event = [NSEvent eventWithCGEvent:raw];
        SEL synthesized = NSSelectorFromString(@"_isSynthesizedKeyEvent");
        BOOL made = [event respondsToSelector:synthesized] && ((BOOL (*)(id, SEL))objc_msgSend)(event, synthesized);
        [kinds addObject:[NSString stringWithFormat:@"%lld/%d", CGEventGetIntegerValueField(event.CGEvent, (CGEventField)76), made]];
        [NSApp sendEvent:event];
        CFRelease(raw);
    }
    return kinds;
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
    report(@"ready", nil);
}

static void command(NSString *line) {
    // The input method answers a key of the key window of the active application within -[NSApplication sendEvent:]: the text
    // view has changed when sendKey returns.
    if ([line isEqual:@"compose"]) {
        NSMutableArray *keys = [NSMutableArray array];
        [keys addObjectsFromArray:sendKey(53)];  // Escape: ends a composition
        personView.string = @"";
        [keys addObjectsFromArray:sendKey(5)];   // g: ㅎ
        [keys addObjectsFromArray:sendKey(40)];  // k: ㅏ
        report(@"composed", @{@"keys": keys});
    } else if ([line isEqual:@"continue"]) {
        report(@"continued", @{@"keys": sendKey(1)});  // s: ㄴ
    } else if ([line isEqual:@"state"]) {
        report(@"state", nil);
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
        // The person does not see the window and clicks through it: it covers nothing of the screen, and it can still be the key
        // window whose text view is the client of the input method.
        window.alphaValue = 0;
        window.ignoresMouseEvents = YES;
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
