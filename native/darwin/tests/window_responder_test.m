// Checks that the first responder observation of a window calls back at each change of the first responder, in a window
// of a class that the application declares and in a class that is declared at run time, that a later observation
// replaces an earlier one, that an ended observation calls back no more, that an observed window is released, that an
// observation ends after its window was released, and that each
// change of the first responder is a record of native.window.first_responder. The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import <stdlib.h>
#import <unistd.h>
#import <mach-o/dyld.h>
#import "window_facts.h"
#import "event_ring.h"
#import "support/records.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// A view that accepts the first responder without a field editor, so each move is one change of the first responder.
@interface SPResponderView : NSView
@end

@implementation SPResponderView
- (BOOL)acceptsFirstResponder { return YES; }
@end

@interface SPDeclaredWindow : NSWindow
@end

@implementation SPDeclaredWindow
@end

// A window class that is declared at run time, as hosts that build their window class with the runtime do.
static Class runtimeWindowClass(void) {
    Class made = objc_allocateClassPair(NSWindow.class, "SPRuntimeWindow", 0);
    objc_registerClassPair(made);
    return made;
}

static void checkWindow(Class windowClass, NSString *label) {
    @autoreleasepool {
        NSWindow *window = [[windowClass alloc] initWithContentRect:NSMakeRect(60, 60, 400, 300)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        [window setReleasedWhenClosed:NO];
        SPResponderView *first = [[[SPResponderView alloc] initWithFrame:NSMakeRect(10, 10, 100, 24)] autorelease];
        SPResponderView *second = [[[SPResponderView alloc] initWithFrame:NSMakeRect(10, 50, 100, 24)] autorelease];
        [window.contentView addSubview:first];
        [window.contentView addSubview:second];
        [window orderFront:nil];
        __block int earlier = 0;
        void *replaced = sp_window_observe_responder(window, ^{ earlier++; });
        check(replaced != NULL, [label stringByAppendingString:@" observation starts"]);
        __block int changes = 0;
        void *observation = sp_window_observe_responder(window, ^{ changes++; });
        check(observation != NULL, [label stringByAppendingString:@" observation is replaced"]);
        [window makeFirstResponder:first];
        int afterFirst = changes;
        check(afterFirst == 1, [NSString stringWithFormat:@"%@ a move to the first view calls back once (%d calls)", label, afterFirst]);
        [window makeFirstResponder:second];
        check(changes == 2, [NSString stringWithFormat:@"%@ a move to the second view calls back once (%d calls)", label, changes]);
        check(earlier == 0, [NSString stringWithFormat:@"%@ the replaced observation stays silent (%d calls)", label, earlier]);
        sp_window_end_responder_observation(replaced);
        [window makeFirstResponder:first];
        check(changes == 3, [NSString stringWithFormat:@"%@ the end of a replaced observation leaves the current one (%d calls)", label, changes]);
        sp_window_end_responder_observation(observation);
        [window makeFirstResponder:second];
        check(changes == 3, [NSString stringWithFormat:@"%@ an ended observation calls back no more (%d calls)", label, changes]);
        [window close];
        [window release];
    }
    @autoreleasepool {
        // An observed window that is released without a close ends its observation with it.
        NSWindow *window = [[windowClass alloc] initWithContentRect:NSMakeRect(60, 60, 400, 300)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        [window setReleasedWhenClosed:NO];
        __block int calls = 0;
        void *observation = sp_window_observe_responder(window, ^{ calls++; });
        check(observation != NULL, [label stringByAppendingString:@" an unshown window is observed"]);
        [window release];
        sp_window_end_responder_observation(observation);
        check(calls == 0, [NSString stringWithFormat:@"%@ an observed window is released (%d calls)", label, calls]);
    }
}

// A change of the first responder is one record of native.window.first_responder with the window number and the classes of the
// views before and after the change; a move to the view that is already the first responder is no record.
static void checkFirstResponderRecords(void) {
    @autoreleasepool {
        const int8_t everything[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
        check(sp_event_set_policy(everything), @"the records policy stores every level");
        NSWindow *window = [[SPDeclaredWindow alloc] initWithContentRect:NSMakeRect(60, 60, 400, 300)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        [window setReleasedWhenClosed:NO];
        SPResponderView *first = [[[SPResponderView alloc] initWithFrame:NSMakeRect(10, 10, 100, 24)] autorelease];
        SPResponderView *second = [[[SPResponderView alloc] initWithFrame:NSMakeRect(10, 50, 100, 24)] autorelease];
        [window.contentView addSubview:first];
        [window.contentView addSubview:second];
        [window orderFront:nil];
        [window makeFirstResponder:first];
        void *observation = sp_window_observe_responder(window, ^{});
        check(observation != NULL, @"first responder records: the observation starts");
        NSArray<NSDictionary *> *moves = capturedEvents(^{
            [window makeFirstResponder:second];
            [window makeFirstResponder:first];
        });
        NSMutableArray<NSDictionary *> *changes = [NSMutableArray array];
        for (NSDictionary *event in moves) {
            if ([event[@"name"] isEqual:@"native.window.first_responder"]) [changes addObject:event[@"fields"]];
        }
        NSString *viewClass = NSStringFromClass([SPResponderView class]);
        check(changes.count == 2, [NSString stringWithFormat:@"two moves record two changes of the first responder (%lu records)", (unsigned long)changes.count]);
        for (NSDictionary *change in changes) {
            check([change[@"window"] intValue] == (int)window.windowNumber && [change[@"from"] isEqual:viewClass] && [change[@"to"] isEqual:viewClass],
                [NSString stringWithFormat:@"a change names the window number and the classes %@ and %@ (%@)", viewClass, viewClass, change]);
        }
        NSArray<NSDictionary *> *same = capturedEvents(^{
            [window makeFirstResponder:first];
        });
        NSUInteger sameChanges = 0;
        for (NSDictionary *event in same) {
            if ([event[@"name"] isEqual:@"native.window.first_responder"]) sameChanges++;
        }
        check(sameChanges == 0, [NSString stringWithFormat:@"a move to the first responder records no change (%lu records)", (unsigned long)sameChanges]);
        sp_window_end_responder_observation(observation);
        [window close];
        [window release];
    }
}

// A host ends the observation in a main-thread step after the window closed, when AppKit may have released the window. The
// end must not touch the released window. The test runs with MallocScribble, so the memory of a released window holds no
// valid object, and a use of it fails instead of reading the stale memory.
static void checkEndAfterRelease(void) {
    NSWindow *window = nil;
    __block int calls = 0;
    void *observation = NULL;
    // A weak slot of the runtime; the test is built without automatic reference counting.
    id weakWindow = nil;
    @autoreleasepool {
        window = [[SPDeclaredWindow alloc] initWithContentRect:NSMakeRect(60, 60, 400, 300)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        [window setReleasedWhenClosed:NO];
        observation = sp_window_observe_responder(window, ^{ calls++; });
        check(observation != NULL, @"end after release: the observation starts");
        objc_storeWeak(&weakWindow, window);
        [window close];
        [window release];
    }
    // The pool held the references that AppKit autoreleased, so the window is released when it drains.
    check(objc_loadWeak(&weakWindow) == nil, @"end after release: the window is released before the end");
    objc_storeWeak(&weakWindow, nil);
    sp_window_end_responder_observation(observation);
    check(calls == 0, [NSString stringWithFormat:@"an observation ends after its window was released (%d calls)", calls]);
}

int main(int argc, char **argv) { @autoreleasepool {
    // MallocScribble applies to a process from its start, so the test starts itself again with it.
    if (!getenv("MallocScribble")) {
        setenv("MallocScribble", "1", 1);
        execv(argv[0], argv);
        fprintf(stderr, "FAIL: the test cannot start itself again with MallocScribble\n");
        return 1;
    }
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    check(sp_window_observe_responder(NULL, ^{}) == NULL, @"an observation without a window is refused");
    checkWindow(SPDeclaredWindow.class, @"declared class:");
    checkWindow(runtimeWindowClass(), @"runtime class:");
    checkFirstResponderRecords();
    checkEndAfterRelease();
    return failures == 0 ? 0 : 1;
} }
