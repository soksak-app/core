// The windows of a person for the native checks (person_window.h).
#import "person_window.h"
#import <QuartzCore/QuartzCore.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>

static const char *const kPersonArgument = "--person-window";

#pragma mark - The person (second process)

static NSMutableDictionary<NSNumber *, NSWindow *> *personWindows;

// Whether the window server lists number among the windows on the screen.
static BOOL listed(long number) {
    NSArray *rows = [(NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID) autorelease];
    for (NSDictionary *row in rows) {
        if ([row[(id)kCGWindowNumber] longValue] == number) return YES;
    }
    return NO;
}

static void answer(NSString *line) {
    fprintf(stdout, "%s\n", line.UTF8String);
    fflush(stdout);
}

// Each command is one line and each answer is one line: "ok <value>" or "error <reason>".
static void personCommand(NSString *line) {
    NSArray<NSString *> *words = [line componentsSeparatedByString:@" "];
    NSString *verb = words.firstObject;
    if ([verb isEqual:@"window"] && words.count == 6) {
        NSRect frame = NSMakeRect(words[1].doubleValue, words[2].doubleValue, words[3].doubleValue, words[4].doubleValue);
        unsigned rgb = 0;
        [[NSScanner scannerWithString:words[5]] scanHexInt:&rgb];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:frame styleMask:NSWindowStyleMaskBorderless
            backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed = NO;
        window.animationBehavior = NSWindowAnimationBehaviorNone;
        window.backgroundColor = [NSColor colorWithSRGBRed:((rgb >> 16) & 0xff) / 255.0 green:((rgb >> 8) & 0xff) / 255.0
            blue:(rgb & 0xff) / 255.0 alpha:1];
        // Behind every window, as a person's window that the check does not bring forward.
        [window orderWindow:NSWindowBelow relativeTo:0];
        [window display];
        // AppKit keeps the order in the open transaction; the window server lists the window once the commit returns.
        [CATransaction flush];
        personWindows[@(window.windowNumber)] = window;
        [window release];
        if (!listed(window.windowNumber)) { answer(@"error the window server does not list the window after the commit"); return; }
        answer([NSString stringWithFormat:@"ok %ld", (long)window.windowNumber]);
    } else if ([verb isEqual:@"above"] && words.count == 3) {
        NSWindow *window = personWindows[@(words[1].integerValue)];
        if (!window) { answer(@"error no window of the person has that number"); return; }
        [window orderWindow:NSWindowAbove relativeTo:words[2].integerValue];
        [CATransaction flush];
        answer(@"ok ordered");
    } else if ([verb isEqual:@"close"] && words.count == 2) {
        NSWindow *window = personWindows[@(words[1].integerValue)];
        if (!window) { answer(@"error no window of the person has that number"); return; }
        long number = window.windowNumber;
        [window close];
        [CATransaction flush];
        [personWindows removeObjectForKey:@(number)];
        answer(listed(number) ? @"error the window server still lists the closed window" : @"ok closed");
    } else if ([verb isEqual:@"active"] && words.count == 1) {
        answer([NSString stringWithFormat:@"ok %d", NSRunningApplication.currentApplication.active ? 1 : 0]);
    } else {
        answer([NSString stringWithFormat:@"error unknown command: %@", line]);
    }
}

int sp_person_child(int argc, char **argv) {
    if (argc != 2 || strcmp(argv[1], kPersonArgument) != 0) return -1;
    @autoreleasepool {
        [NSApplication sharedApplication];
        // A person's application that the check never activates: its windows stand where the person put them.
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        [NSApp finishLaunching];
        personWindows = [NSMutableDictionary new];
        answer(@"ok ready");
        char buffer[512];
        // The end of standard input, which the end of the check causes, ends the person.
        while (fgets(buffer, sizeof buffer, stdin)) {
            @autoreleasepool {
                NSString *line = [[NSString stringWithUTF8String:buffer]
                    stringByTrimmingCharactersInSet:NSCharacterSet.newlineCharacterSet];
                if ([line isEqual:@"quit"]) break;
                personCommand(line);
            }
        }
        for (NSWindow *window in personWindows.allValues) [window close];
        [personWindows release];
    }
    return 0;
}

#pragma mark - The check

static NSTask *person;
static NSFileHandle *toPerson, *fromPerson;
static NSMutableData *pending;

// Reads one answer line; nil when the person ended before it answered.
static NSString *readAnswer(void) {
    for (;;) {
        const char *bytes = pending.bytes;
        const char *newline = memchr(bytes, '\n', pending.length);
        if (newline) {
            NSUInteger length = (NSUInteger)(newline - bytes);
            NSString *line = [[[NSString alloc] initWithBytes:bytes length:length encoding:NSUTF8StringEncoding] autorelease];
            [pending replaceBytesInRange:NSMakeRange(0, length + 1) withBytes:NULL length:0];
            return line ?: @"";
        }
        // availableData waits for data or for the end of the pipe, which the exit of the person causes.
        NSData *data = fromPerson.availableData;
        if (data.length == 0) return nil;
        [pending appendData:data];
    }
}

// Sends command and returns the value of its "ok" answer, or nil with the reason written to stderr.
static NSString *request(NSString *command) {
    if (!person) { fprintf(stderr, "the person is not started\n"); return nil; }
    [toPerson writeData:[[command stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding]];
    NSString *line = readAnswer();
    if (!line) { fprintf(stderr, "the person ended before it answered %s\n", command.UTF8String); return nil; }
    if (![line hasPrefix:@"ok "]) { fprintf(stderr, "the person refused %s: %s\n", command.UTF8String, line.UTF8String); return nil; }
    return [line substringFromIndex:3];
}

BOOL sp_person_start(const char *path) {
    if (person) return YES;
    // A person that ended closes its pipe; a later request then fails with the write error instead of ending the check.
    signal(SIGPIPE, SIG_IGN);
    NSPipe *input = [NSPipe pipe], *output = [NSPipe pipe];
    person = [NSTask new];
    person.executableURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path]];
    person.arguments = @[ [NSString stringWithUTF8String:kPersonArgument] ];
    person.standardInput = input;
    person.standardOutput = output;
    NSError *error = nil;
    if (![person launchAndReturnError:&error]) {
        fprintf(stderr, "the person does not start: %s\n", error.localizedDescription.UTF8String);
        [person release];
        person = nil;
        return NO;
    }
    toPerson = [input.fileHandleForWriting retain];
    fromPerson = [output.fileHandleForReading retain];
    pending = [NSMutableData new];
    NSString *ready = readAnswer();
    if (![ready isEqual:@"ok ready"]) {
        fprintf(stderr, "the person did not report ready: %s\n", ready ? ready.UTF8String : "it ended");
        sp_person_end();
        return NO;
    }
    return YES;
}

long sp_person_window(NSRect frame, uint32_t rgb) {
    NSString *number = request([NSString stringWithFormat:@"window %.0f %.0f %.0f %.0f %06x", frame.origin.x, frame.origin.y,
        frame.size.width, frame.size.height, rgb]);
    return number ? number.integerValue : -1;
}

BOOL sp_person_order_above(long number, long target) {
    return request([NSString stringWithFormat:@"above %ld %ld", number, target]) != nil;
}

BOOL sp_person_close(long number) {
    return request([NSString stringWithFormat:@"close %ld", number]) != nil;
}

int sp_person_active(void) {
    NSString *value = request(@"active");
    return value ? value.intValue : -1;
}

pid_t sp_person_pid(void) {
    return person ? person.processIdentifier : 0;
}

void sp_person_end(void) {
    if (!person) return;
    @try { [toPerson writeData:[@"quit\n" dataUsingEncoding:NSUTF8StringEncoding]]; } @catch (NSException *exception) {}
    [toPerson closeFile];
    [person waitUntilExit];
    [toPerson release]; [fromPerson release]; [pending release]; [person release];
    toPerson = fromPerson = nil; pending = nil; person = nil;
}
