// Judges whether the input method of the system composes the keys of the virtual key window (docs/spec/exposure.md#virtual-key-window)
// and whether those keys take the composition of the application that a person uses.
//
// The test selects Korean 2-Set as the input source of the system for its run and restores the previous source at its end, also
// when it fails, ends by an uncaught exception or ends by a signal that a process can catch. It starts ime_person_app
// (SOKSAK_IME_PERSON_APP), which takes the front as the application of a person, with a window that shows nothing and lets clicks
// pass, and composes 하 in its own text view; at its end it returns the front to the application that held it. This
// application stays behind and is never active: a text view in its covered window takes g k s and Space, Backspace or Escape
// through input.key, which makes that window the virtual key window. A person's input method composes those keys as 한 Space,
// 하 and 한 (the AppKit reference of image_region_ime_test). After each sequence the composition of the person must stay as it was.
//
// The same run measures, without judging, whether the input method composes those keys once the input context of the text view is
// activated (-[NSTextInputContext activate]), and what that does to the composition of the person. It changes the input source of
// the system and the front, so it runs only in make test-app-activation.
//
// -[NSTextInputContext handleEvent:] reads the answer of the input method when the call that it makes to the input method returns,
// so the changes of a key arrive within its delivery; each sequence still runs the main queue before it is judged.
#import <Cocoa/Cocoa.h>
#import <Carbon/Carbon.h>
#include <signal.h>
#include <unistd.h>
#import "input_inject.h"
#import "input_source.h"
#import "input_virtual.h"
#import "support/event_wait.h"

static NSString *const KOREAN_2SET = @"com.apple.inputmethod.Korean.2SetKorean";

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// The input source of the system before the run, which every end of the process restores, and the person's application.
static NSString *originalSource;
static volatile sig_atomic_t sourceRestored;
static volatile pid_t personProcess;

static NSString *currentSource(void) {
    char *identifier = sp_input_source_current();
    NSString *result = identifier ? [NSString stringWithUTF8String:identifier] : nil;
    free(identifier);
    return result;
}

// Selects an input source at once, for an end of the process that cannot wait for the answer.
static void selectNow(NSString *identifier) {
    CFArrayRef list = TISCreateInputSourceList((CFDictionaryRef)@{(NSString *)kTISPropertyInputSourceID: identifier}, false);
    if (list && CFArrayGetCount(list) > 0) TISSelectInputSource((TISInputSourceRef)CFArrayGetValueAtIndex(list, 0));
    if (list) CFRelease(list);
}

static void restoreSourceNow(void) {
    if (sourceRestored || !originalSource) return;
    sourceRestored = 1;
    selectNow(originalSource);
}

// The end of the process by a signal restores the source and ends the person's application before the signal ends the process.
static void endBySignal(int signal) {
    restoreSourceNow();
    if (personProcess > 0) kill(personProcess, SIGTERM);
    struct sigaction initial = { .sa_handler = SIG_DFL };
    sigaction(signal, &initial, NULL);
    raise(signal);
}

static void endByException(NSException *exception) {
    (void)exception;
    restoreSourceNow();
}

static void installRestoration(void) {
    atexit(restoreSourceNow);
    NSSetUncaughtExceptionHandler(endByException);
    struct sigaction action = { .sa_handler = endBySignal };
    sigemptyset(&action.sa_mask);
    int signals[] = { SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGFPE };
    for (size_t i = 0; i < sizeof signals / sizeof signals[0]; i++) sigaction(signals[i], &action, NULL);
}

// Selects the input source of the system and waits for its answer. The answer can come from a timer of the library, which does
// not end a turn of the run loop, so the answer wakes the wait.
static BOOL selectAndAwait(NSString *source) {
    __block BOOL answered = NO;
    __block NSString *reason = nil;
    sp_input_source_select_and_await(source.UTF8String, NULL, ^(const char *error) {
        answered = YES;
        reason = error ? [[NSString alloc] initWithUTF8String:error] : nil;
        eventWake();
    });
    eventWait([NSString stringWithFormat:@"the selection of %@ answers", source], ^BOOL { return answered; });
    BOOL selected = reason == nil && [currentSource() isEqual:source];
    if (reason) fprintf(stderr, "NOTE: the selection of %s answers %s\n", source.UTF8String, reason.UTF8String);
    [reason release];
    return selected;
}

// Runs the main queue until a marker block queued after every block already on it has run.
static void drainMainQueue(NSString *what) {
    __block BOOL passed = NO;
    dispatch_async(dispatch_get_main_queue(), ^{ passed = YES; });
    eventWait(what, ^BOOL { return passed; });
}

// The person's application: its reports, one JSON object per line, in the order of their arrival.
static NSTask *person;
static NSFileHandle *personInput;
static NSMutableArray<NSDictionary *> *personReports;
static BOOL personEnded;

static void startPerson(NSString *path) {
    personReports = [[NSMutableArray alloc] init];
    person = [[NSTask alloc] init];
    person.executableURL = [NSURL fileURLWithPath:path];
    person.arguments = @[[NSString stringWithFormat:@"%d", NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier]];
    NSPipe *input = [NSPipe pipe], *output = [NSPipe pipe];
    person.standardInput = input;
    person.standardOutput = output;
    personInput = [input.fileHandleForWriting retain];
    NSMutableData *pending = [[NSMutableData alloc] init];
    output.fileHandleForReading.readabilityHandler = ^(NSFileHandle *handle) {
        NSData *data = handle.availableData;
        dispatch_async(dispatch_get_main_queue(), ^{
            if (data.length == 0) {
                personEnded = YES;
                handle.readabilityHandler = nil;
            }
            [pending appendData:data];
            for (;;) {
                NSRange end = [pending rangeOfData:[NSData dataWithBytes:"\n" length:1] options:0 range:NSMakeRange(0, pending.length)];
                if (end.location == NSNotFound) break;
                NSData *line = [pending subdataWithRange:NSMakeRange(0, end.location)];
                [pending replaceBytesInRange:NSMakeRange(0, end.location + 1) withBytes:NULL length:0];
                NSDictionary *report = [NSJSONSerialization JSONObjectWithData:line options:0 error:NULL];
                NSString *text = [[[NSString alloc] initWithData:line encoding:NSUTF8StringEncoding] autorelease];
                fprintf(stdout, "PERSON: %s\n", text.UTF8String);
                [personReports addObject:[report isKindOfClass:NSDictionary.class] ? report : @{@"kind": @"invalid"}];
            }
            eventWake();
        });
    };
    person.terminationHandler = ^(NSTask *task) {
        dispatch_async(dispatch_get_main_queue(), ^{ personEnded = YES; eventWake(); });
    };
    NSError *error = nil;
    BOOL launched = [person launchAndReturnError:&error];
    check(launched, [NSString stringWithFormat:@"the person's application starts (%@)", error.localizedDescription ?: path]);
    if (launched) personProcess = person.processIdentifier;
}

static void tellPerson(NSString *command) {
    NSData *line = [[command stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
    @try {
        [personInput writeData:line];
    } @catch (NSException *exception) {
        check(NO, [NSString stringWithFormat:@"the person's application takes %@ (%@)", command, exception.reason]);
    }
}

// The first report of kind at or after index from, or nil when the person's application ended without it.
static NSDictionary *awaitPerson(NSString *kind, NSUInteger from) {
    __block NSDictionary *found = nil;
    eventWait([NSString stringWithFormat:@"the person's application reports %@", kind], ^BOOL {
        for (NSUInteger i = from; i < personReports.count; i++) {
            if ([personReports[i][@"kind"] isEqual:kind]) { found = personReports[i]; return YES; }
        }
        return personEnded;
    });
    return found;
}

// The changes of the person's text view by the input method that arrived at or after index from.
static NSArray<NSDictionary *> *personChangesFrom(NSUInteger from) {
    NSMutableArray *changes = [NSMutableArray array];
    for (NSUInteger i = from; i < personReports.count; i++) {
        NSString *kind = personReports[i][@"kind"];
        if ([kind isEqual:@"mark"] || [kind isEqual:@"insert"] || [kind isEqual:@"unmark"]) [changes addObject:personReports[i]];
    }
    return changes;
}

// The state of the person's text view now: its marked text and its text.
static NSDictionary *personState(void) {
    NSUInteger from = personReports.count;
    tellPerson(@"state");
    return awaitPerson(@"state", from);
}

// The text view of this application, which records each call of the input method and each command.
@interface SPRecordingTextView : NSTextView
@property(retain) NSMutableArray<NSString *> *calls;
@end
@implementation SPRecordingTextView
static NSString *plain(id string) {
    return [string isKindOfClass:NSAttributedString.class] ? [(NSAttributedString *)string string] : (NSString *)string;
}
- (void)setMarkedText:(id)string selectedRange:(NSRange)selectedRange replacementRange:(NSRange)replacementRange {
    [self.calls addObject:[NSString stringWithFormat:@"mark(%@)", plain(string)]];
    [super setMarkedText:string selectedRange:selectedRange replacementRange:replacementRange];
}
- (void)insertText:(id)string replacementRange:(NSRange)replacementRange {
    [self.calls addObject:[NSString stringWithFormat:@"insert(%@)", plain(string)]];
    [super insertText:string replacementRange:replacementRange];
}
- (void)unmarkText {
    [self.calls addObject:@"unmark"];
    [super unmarkText];
}
// Escape without the input method asks the text view for completions, whose panel this test does not open.
- (void)doCommandBySelector:(SEL)selector {
    [self.calls addObject:[NSString stringWithFormat:@"command(%@)", NSStringFromSelector(selector)]];
    if (selector == @selector(cancelOperation:) || selector == @selector(complete:)) return;
    [super doCommandBySelector:selector];
}
- (void)dealloc {
    [_calls release];
    [super dealloc];
}
@end

static void clearView(SPRecordingTextView *view) {
    [view.inputContext discardMarkedText];
    view.string = @"";
    [view.calls removeAllObjects];
}

// Sends each key down and up through input.key, then runs the main queue. Returns whether every key was delivered.
static BOOL typeKeys(NSWindow *window, NSArray<NSString *> *keys) {
    BOOL delivered = YES;
    for (NSString *key in keys) {
        delivered = sp_input_key(window, key.UTF8String, NULL, 0, true) == SP_INPUT_DELIVERED
            && sp_input_key(window, key.UTF8String, NULL, 0, false) == SP_INPUT_DELIVERED && delivered;
    }
    drainMainQueue(@"the blocks that the keys queued run");
    return delivered;
}

static NSString *describe(SPRecordingTextView *view) {
    return [NSString stringWithFormat:@"text '%@', marked %d, calls %@", view.string, view.hasMarkedText,
        [view.calls componentsJoinedByString:@"; "]];
}

// Whether the composition of the person stayed as it was: no change by the input method since index from, and 하 still marked
// in an empty text.
static void checkPersonKept(NSUInteger from, NSString *after) {
    NSArray *changes = personChangesFrom(from);
    NSDictionary *state = personState();
    check(changes.count == 0 && [state[@"marked"] isEqual:@"하"] && [state[@"text"] isEqual:@"하"],
        [NSString stringWithFormat:@"the composition of the person stays 하 after %@ (changes %@, state %@)", after, changes, state]);
}

static void measurePerson(NSUInteger from, NSString *after) {
    NSArray *changes = personChangesFrom(from);
    NSDictionary *state = personState();
    printf("MEASURE: the person's text view after %s: changes %s, state %s\n", after.UTF8String,
        [changes.description stringByReplacingOccurrencesOfString:@"\n" withString:@" "].UTF8String,
        [state.description stringByReplacingOccurrencesOfString:@"\n" withString:@" "].UTF8String);
}

// Whether this process stayed behind: it is not the frontmost application and the system does not hold it as active.
static BOOL stayedBehind(void) {
    return NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != getpid()
        && !NSRunningApplication.currentApplication.isActive;
}

static int finish(void) {
    if (person && !personEnded) {
        tellPerson(@"quit");
        eventWait(@"the person's application ends", ^BOOL { return personEnded; });
    }
    if (originalSource && !sourceRestored) {
        BOOL restored = selectAndAwait(originalSource);
        sourceRestored = 1;
        check(restored, [NSString stringWithFormat:@"the input source of the system is %@ again (now %@)", originalSource, currentSource()]);
    }
    check(stayedBehind(), @"the application did not become active");
    return failures ? 1 : 0;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    NSString *personPath = NSProcessInfo.processInfo.environment[@"SOKSAK_IME_PERSON_APP"];
    check(personPath.length > 0, @"SOKSAK_IME_PERSON_APP names the person's application");
    if (personPath.length == 0) return finish();

    originalSource = [currentSource() copy];
    check(originalSource != nil, [NSString stringWithFormat:@"the input source of the system is read (%@)", originalSource]);
    if (!originalSource) return finish();
    installRestoration();
    check(selectAndAwait(KOREAN_2SET), @"Korean 2-Set is the input source of the system for the run");
    if (![currentSource() isEqual:KOREAN_2SET]) return finish();

    // The person's application takes the front and composes 하 in its own text view.
    startPerson(personPath);
    NSDictionary *ready = awaitPerson(@"ready", 0);
    check([ready[@"front"] boolValue] && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == personProcess
        && [ready[@"source"] isEqual:KOREAN_2SET], [NSString stringWithFormat:@"the person's application is in front with Korean 2-Set (%@)", ready]);
    if (!ready) return finish();
    tellPerson(@"compose");
    NSDictionary *composed = awaitPerson(@"composed", 0);
    printf("NOTE: the window of the person shows nothing (alpha %s) and is its key window (%s); its input context is current (%s), "
        "and the input method composes in it: %s\n", [composed[@"alpha"] description].UTF8String, [composed[@"front"] description].UTF8String,
        [composed[@"current"] description].UTF8String, [composed[@"marked"] isEqual:@"하"] ? "yes" : "no");
    check([composed[@"marked"] isEqual:@"하"], [NSString stringWithFormat:@"the person composes 하 (%@)", composed]);
    if (![composed[@"marked"] isEqual:@"하"]) return finish();

    // The covered window of this application, with a text view as its first responder.
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(240, 240, 360, 120)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    // The window shows nothing, so it covers nothing of the screen of the person.
    window.alphaValue = 0;
    SPRecordingTextView *view = [[[SPRecordingTextView alloc] initWithFrame:NSMakeRect(0, 0, 360, 120)] autorelease];
    view.calls = [NSMutableArray array];
    window.contentView = view;
    [window makeFirstResponder:view];
    [window orderBack:nil];

    // The keys of the virtual key window, as input.key gives them.
    NSUInteger from = personReports.count;
    check(typeKeys(window, @[@"g", @"k", @"s", @"Space"]) && sp_input_virtual_is(window), @"g k s Space of the virtual key window are delivered");
    check([view.string isEqual:@"한 "] && !view.hasMarkedText,
        [NSString stringWithFormat:@"the input method composes g k s Space of the virtual key window into 한 and a space (%@)", describe(view)]);
    checkPersonKept(from, @"g k s Space");

    clearView(view);
    from = personReports.count;
    typeKeys(window, @[@"g", @"k", @"s", @"Backspace"]);
    check([view.string isEqual:@"하"],
        [NSString stringWithFormat:@"Backspace of the virtual key window during a composition reaches the input method and leaves 하 (%@)", describe(view)]);
    checkPersonKept(from, @"g k s Backspace");

    clearView(view);
    from = personReports.count;
    typeKeys(window, @[@"g", @"k", @"s", @"Escape"]);
    check([view.string isEqual:@"한"] && !view.hasMarkedText,
        [NSString stringWithFormat:@"Escape of the virtual key window during a composition ends it and leaves 한 (%@)", describe(view)]);
    checkPersonKept(from, @"g k s Escape");

    // Measurement: the input context of the text view activated as AppKit activates the context of the key window of an active
    // application.
    clearView(view);
    from = personReports.count;
    [view.inputContext activate];
    printf("MEASURE: after the activation of the input context of the virtual key window, current context is it %d, source %s\n",
        NSTextInputContext.currentInputContext == view.inputContext, view.inputContext.selectedKeyboardInputSource.UTF8String ?: "none");
    measurePerson(from, @"the activation of the input context of the virtual key window");
    from = personReports.count;
    typeKeys(window, @[@"g", @"k", @"s", @"Space"]);
    printf("MEASURE: with the input context activated, g k s Space of the virtual key window give %s\n", describe(view).UTF8String);
    measurePerson(from, @"g k s Space with the input context activated");
    [view.inputContext deactivate];
    clearView(view);

    sp_input_virtual_end("no state");
    [window close];
    [window release];
    return finish();
} }
