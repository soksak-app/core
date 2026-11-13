// Checks that the emulated input of a window (sp_input_pointer, sp_input_key) reaches the system panels that the application
// shows over that window, as the input of a person reaches them in an application that is not active: an alert sheet, a context
// menu, the menu of a pop-up button, and a save and an open panel sheet. The window stands behind a window of its own that covers
// it, and the test process is never active, so the input passes the application as the input of the virtual key window does.
//
// Each input goes to the window that the caller names, at window points of its content (origin at the top left), as an input
// of the endpoint names the window of its request: a person presses at a point of the screen, and the panel over the window
// takes the press. A case judges what the panel did with the input: the button that ended the sheet, the item that the menu
// ran, read before the test ends what the input left. A sheet answers NOT_ENDED until its completion runs, so a sheet that the
// input did not end is told from one that it cancelled (NSModalResponseCancel is 0). An alert sheet or a menu that the input
// did not reach is ended by the test after the input has been handled, so the next case runs. The open and save panel cases come
// last: the content of such a panel runs in a service of the system and the panel is the person's, so its input is refused.
#import <Cocoa/Cocoa.h>
#import <OSLog/OSLog.h>
#import <objc/runtime.h>
#import "input_inject.h"
#import "input_virtual.h"
#import "event_ring.h"
#import "support/event_wait.h"
#import "support/records.h"
#import "support/temporary_folder.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}
static void note(NSString *message) { fprintf(stdout, "NOTE: %s\n", message.UTF8String); }

// The response of a sheet whose completion has not run.
static const NSModalResponse NOT_ENDED = NSIntegerMin;

// Writes the menu tracking records of AppKit for this process since since (NSMenuTrackingLoggingEnabled), so a menu that did not
// take the input states what its tracking did with each event.
static void noteLog(NSDate *since, NSPredicate *predicate, NSString *source, NSString *what) {
    NSError *error = nil;
    OSLogStore *store = [OSLogStore storeWithScope:OSLogStoreCurrentProcessIdentifier error:&error];
    OSLogEnumerator *entries = [store entriesEnumeratorWithOptions:0 position:[store positionWithDate:since] predicate:predicate
        error:&error];
    if (!entries) { note([NSString stringWithFormat:@"%@: the log of the process cannot be read: %@", what, error]); return; }
    NSUInteger count = 0;
    for (OSLogEntry *entry in entries) {
        note([NSString stringWithFormat:@"%@: %@ %@", what, source, entry.composedMessage]);
        count++;
    }
    note([NSString stringWithFormat:@"%@: %lu %@ log entries of the process", what, (unsigned long)count, source]);
}
static void noteMenuTracking(NSDate *since, NSString *what) {
    noteLog(since, [NSPredicate predicateWithFormat:@"subsystem == 'com.apple.AppKit' AND category CONTAINS[c] 'Menu'"], @"AppKit",
        what);
}

static const char *resultText(sp_input_result result) {
    switch (result) {
        case SP_INPUT_DELIVERED: return "delivered";
        case SP_INPUT_REJECTED: return "rejected";
        case SP_INPUT_INACTIVE: return "inactive";
        case SP_INPUT_UNRECEIVED: return "unreceived";
        case SP_INPUT_BUTTON_HELD: return "button held";
        case SP_INPUT_PRESS_OPEN: return "press open";
        case SP_INPUT_POINTER_HELD: return "pointer held";
    }
    return "unknown";
}

// The marks that the application has dispatched. A mark is an application-defined event at the end of the event queue, so its
// dispatch follows every event that was queued before it.
static NSInteger marksSeen;
static NSInteger marksPosted;
static void installMarks(void) {
    [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskApplicationDefined handler:^NSEvent *(NSEvent *event) {
        if (event.subtype == 77) { marksSeen = MAX(marksSeen, (NSInteger)event.data1); return nil; }
        return event;
    }];
}
// Waits until the application has dispatched every event that was queued before this call.
static void settle(NSString *what) {
    NSInteger mark = ++marksPosted;
    [NSApp postEvent:[NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0 timestamp:0
        windowNumber:0 context:nil subtype:77 data1:mark data2:0] atStart:NO];
    eventWait(what, ^BOOL { return marksSeen >= mark; });
}

// The window point (origin at the top left of the content) of window that shows the screen point of the center of view.
static NSPoint pointOf(NSWindow *window, NSView *view) {
    NSRect rect = [view.window convertRectToScreen:[view convertRect:view.bounds toView:nil]];
    NSPoint base = [window convertPointFromScreen:NSMakePoint(NSMidX(rect), NSMidY(rect))];
    NSView *content = window.contentView;
    NSPoint local = [content convertPoint:base fromView:nil];
    return NSMakePoint(local.x, content.isFlipped ? local.y : NSHeight(content.bounds) - local.y);
}
static NSPoint pointOfScreenRect(NSWindow *window, NSRect rect) {
    NSPoint base = [window convertPointFromScreen:NSMakePoint(NSMidX(rect), NSMidY(rect))];
    NSView *content = window.contentView;
    NSPoint local = [content convertPoint:base fromView:nil];
    return NSMakePoint(local.x, content.isFlipped ? local.y : NSHeight(content.bounds) - local.y);
}

// Presses and releases button at point of window. The release is a request of its own, as the endpoint gives it: it runs in the
// next turn of the main thread, which is inside the event loop of a view that tracks the press (a button) when the press runs one.
static void click(NSWindow *window, NSPoint point, int button, NSString *what) {
    __block sp_input_result up = SP_INPUT_REJECTED;
    __block BOOL released = NO;
    dispatch_async(dispatch_get_main_queue(), ^{
        up = sp_input_pointer_clicks(window, point.x, point.y, 3, button, 1);
        released = YES;
    });
    sp_input_result down = sp_input_pointer_clicks(window, point.x, point.y, 1, button, 1);
    eventWait([what stringByAppendingString:@": the release is delivered"], ^BOOL { return released; });
    note([NSString stringWithFormat:@"%@: press %s, release %s at %@", what, resultText(down), resultText(up),
        NSStringFromPoint(point)]);
}

// The trace of the path of an input of a sheet: each window that -[NSWindow sendEvent:] gives a mouse or key event, and each
// button that takes a press or a key equivalent, written as a NOTE while tracing is set.
static BOOL tracing;
static void (*appKitWindowSendEvent)(id, SEL, NSEvent *);
static void (*appKitButtonMouseDown)(id, SEL, NSEvent *);
static BOOL (*appKitWindowKeyEquivalent)(id, SEL, NSEvent *);
static NSString *eventKind(NSEvent *event) {
    switch (event.type) {
        case NSEventTypeLeftMouseDown: return @"left down";
        case NSEventTypeLeftMouseUp: return @"left up";
        case NSEventTypeKeyDown: return [NSString stringWithFormat:@"key down %hu flags %#lx", event.keyCode,
            (unsigned long)(event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask)];
        case NSEventTypeKeyUp: return @"key up";
        default: return nil;
    }
}
static void traceWindowSendEvent(NSWindow *self, SEL selector, NSEvent *event) {
    NSString *kind = tracing ? eventKind(event) : nil;
    if (kind) note([NSString stringWithFormat:@"trace: -[NSWindow sendEvent:] of %@ (%@, key %d, sheet %d) takes %@ at %@",
        self.class, self.title, self.isKeyWindow, self.isSheet, kind, NSStringFromPoint(event.locationInWindow)]);
    appKitWindowSendEvent(self, selector, event);
}
// AppKit implements -mouseDown: of a button in NSControl, so the trace sees the press of every control.
static void traceButtonMouseDown(NSControl *self, SEL selector, NSEvent *event) {
    if (tracing) note([NSString stringWithFormat:@"trace: -[%@ mouseDown:] of %@ is reached", self.class,
        [self isKindOfClass:NSButton.class] ? ((NSButton *)self).title : @"a control"]);
    appKitButtonMouseDown(self, selector, event);
}
static BOOL traceWindowKeyEquivalent(NSWindow *self, SEL selector, NSEvent *event) {
    BOOL taken = appKitWindowKeyEquivalent(self, selector, event);
    if (tracing) note([NSString stringWithFormat:@"trace: -[NSWindow performKeyEquivalent:] of %@ answers %d for %@", self.class,
        taken, eventKind(event)]);
    return taken;
}
static void installTrace(void) {
    appKitWindowSendEvent = (void (*)(id, SEL, NSEvent *))method_setImplementation(
        class_getInstanceMethod(NSWindow.class, @selector(sendEvent:)), (IMP)traceWindowSendEvent);
    appKitButtonMouseDown = (void (*)(id, SEL, NSEvent *))method_setImplementation(
        class_getInstanceMethod(NSButton.class, @selector(mouseDown:)), (IMP)traceButtonMouseDown);
    appKitWindowKeyEquivalent = (BOOL (*)(id, SEL, NSEvent *))method_setImplementation(
        class_getInstanceMethod(NSWindow.class, @selector(performKeyEquivalent:)), (IMP)traceWindowKeyEquivalent);
}
// A key with no stated text types the character of the key in the input source of the person, which need not be a latin one, so a
// letter states its text, as the endpoint does for a typed letter.
static void key(NSWindow *window, const char *name, NSString *what) {
    const char *text = strlen(name) == 1 ? name : NULL;
    sp_input_result down = sp_input_key(window, name, text, 0, true);
    sp_input_result up = sp_input_key(window, name, text, 0, false);
    note([NSString stringWithFormat:@"%@: key %s down %s, up %s", what, name, resultText(down), resultText(up)]);
}

// The facts of a panel: its class, whether the application holds its window, the process that owns its window in the window
// server, and its frame.
static NSString *panelFacts(NSWindow *panel) {
    NSArray *info = [(NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, (CGWindowID)panel.windowNumber)
        autorelease];
    return [NSString stringWithFormat:@"class %@, in the windows of the application %@, window %ld owned by pid %@ (own pid %d), "
        @"frame %@, content %@", NSStringFromClass(panel.class), [NSApp.windows containsObject:panel] ? @"YES" : @"NO",
        (long)panel.windowNumber, info.firstObject[(id)kCGWindowOwnerPID] ?: @"-", getpid(), NSStringFromRect(panel.frame),
        NSStringFromClass(panel.contentView.class)];
}

// Ends a sheet of window that the input did not end, after the input was handled.
static void endSheet(NSWindow *window, NSString *what) {
    NSWindow *sheet = window.attachedSheet;
    if (!sheet) return;
    note([NSString stringWithFormat:@"%@: the test ends the sheet that the input left", what]);
    [window endSheet:sheet returnCode:NSModalResponseAbort];
    eventWait([what stringByAppendingString:@": the sheet ends"], ^BOOL { return window.attachedSheet == nil; });
}

static NSAlert *showAlert(NSWindow *window, NSModalResponse *response) {
    NSAlert *alert = [[NSAlert new] autorelease];
    alert.messageText = @"Panel check";
    [alert addButtonWithTitle:@"First"];
    [alert addButtonWithTitle:@"Second"];
    *response = NOT_ENDED;
    [alert beginSheetModalForWindow:window completionHandler:^(NSModalResponse returned) { *response = returned; }];
    eventWait(@"the alert sheet shows", ^BOOL { return alert.window.isVisible; });
    return alert;
}

// A view whose context menu is its menu.
@interface MenuView : NSView
@end
@implementation MenuView
- (BOOL)isFlipped { return YES; }
@end

@interface MenuTarget : NSObject
@property NSInteger runs;
@property(copy) NSString *chosen;
- (void)act:(id)sender;
- (void)choose:(NSPopUpButton *)sender;
@end
@implementation MenuTarget
- (void)act:(id)sender { self.runs++; }
- (void)choose:(NSPopUpButton *)sender { self.chosen = sender.titleOfSelectedItem; }
- (void)dealloc { [_chosen release]; [super dealloc]; }
@end

// The window of the application at a menu level that shows a menu, or nil.
static NSWindow *menuWindow(NSWindow *except) {
    for (NSWindow *window in NSApp.windows) {
        if (window != except && window.isVisible && window.level >= NSPopUpMenuWindowLevel) return window;
    }
    return nil;
}

// Runs attempt once the menu tracks. A menu whose input ends it (ends) closes by that input: a release over an item dismisses the
// menu and the menu runs the item when its dismissal ends (-[NSMenuTrackingSession performActionUponDismissal:]), which can come
// after the next block of the main queue, so a cancel of the tracking in that block would drop the action of the item. A menu
// whose input does not end it on this system has its tracking ended by the test after the events that attempt queued.
static void whileTracking(NSMenu *menu, NSString *what, BOOL ends, BOOL *tracked, void (^attempt)(void)) {
    __block id observer = [NSNotificationCenter.defaultCenter addObserverForName:NSMenuDidBeginTrackingNotification object:menu
        queue:nil usingBlock:^(NSNotification *note_) {
            [NSNotificationCenter.defaultCenter removeObserver:observer];
            *tracked = YES;
            dispatch_async(dispatch_get_main_queue(), ^{
                attempt();
                if (ends) return;
                dispatch_async(dispatch_get_main_queue(), ^{
                    if (menuWindow(nil)) note([NSString stringWithFormat:@"%@: the test ends the tracking that the input left", what]);
                    [menu cancelTracking];
                });
            });
        }];
}

int main(void) { @autoreleasepool {
    setvbuf(stdout, NULL, _IOLBF, 0);
    [NSUserDefaults.standardUserDefaults registerDefaults:@{@"NSMenuTrackingLoggingEnabled": @YES}];
    // The record of a key, whose reason the refused Return cases read, is an info record of the ring; the default policy of the
    // ring stores only errors.
    const int8_t infoPolicy[SP_CLASS_COUNT] = {SP_EVENT_INFO, SP_EVENT_INFO, SP_EVENT_INFO, SP_EVENT_INFO, SP_EVENT_INFO};
    check(sp_event_set_policy(infoPolicy), @"the policy stores info records");
    [NSApplication sharedApplication];
    [NSApp finishLaunching];
    installMarks();
    installTrace();

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(160, 160, 640, 480)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    MenuView *content = [[[MenuView alloc] initWithFrame:NSMakeRect(0, 0, 640, 480)] autorelease];
    window.contentView = content;
    [window orderBack:nil];
    // A window of the test covers the window, as a window of a person does.
    NSWindow *cover = [[NSWindow alloc] initWithContentRect:NSMakeRect(140, 140, 700, 560)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    cover.releasedWhenClosed = NO;
    cover.backgroundColor = NSColor.grayColor;
    [cover orderWindow:NSWindowAbove relativeTo:window.windowNumber];
    check(!NSRunningApplication.currentApplication.active, @"the application is not active");

    // An alert sheet: a press of its first button ends it with that button.
    tracing = YES;
    NSModalResponse response = 0;
    NSAlert *alert = showAlert(window, &response);
    note([@"alert sheet: " stringByAppendingString:panelFacts(alert.window)]);
    note([NSString stringWithFormat:@"alert sheet: the window server order of the application holds the sheet %d",
        [[NSWindow windowNumbersWithOptions:0] containsObject:@(alert.window.windowNumber)]]);
    click(window, pointOf(window, alert.buttons[0]), 0, @"alert sheet");
    settle(@"the press of the alert is handled");
    check(response == NSAlertFirstButtonReturn,
        [NSString stringWithFormat:@"a press of the first button of an alert sheet ends it with that button (response %ld)", (long)response]);
    endSheet(window, @"alert sheet press");

    // Return presses the default button of the alert sheet, and Escape its cancel button.
    alert = showAlert(window, &response);
    NSButton *first = alert.buttons[0];
    note([NSString stringWithFormat:@"alert sheet: first button key equivalent %@ modifiers %lu, default button %@, first responder %@",
        [first.keyEquivalent isEqualToString:@"\r"] ? @"Return" : first.keyEquivalent, (unsigned long)first.keyEquivalentModifierMask,
        alert.window.defaultButtonCell.title, alert.window.firstResponder.class]);
    key(window, "Enter", @"alert sheet");
    settle(@"the key of the alert is handled");
    check(response == NSAlertFirstButtonReturn,
        [NSString stringWithFormat:@"Return ends an alert sheet with its default button (response %ld)", (long)response]);
    endSheet(window, @"alert sheet Return");
    alert = showAlert(window, &response);
    [alert.buttons[1] setKeyEquivalent:@"\033"];
    key(window, "Escape", @"alert sheet");
    settle(@"the Escape of the alert is handled");
    check(response == NSAlertSecondButtonReturn,
        [NSString stringWithFormat:@"Escape ends an alert sheet with its cancel button (response %ld)", (long)response]);
    endSheet(window, @"alert sheet Escape");
    tracing = NO;

    // A context menu: a right press opens it, and the release over its item runs the item.
    MenuTarget *target = [[MenuTarget new] autorelease];
    NSMenu *context = [[[NSMenu alloc] initWithTitle:@"Context"] autorelease];
    NSMenuItem *act = [[[NSMenuItem alloc] initWithTitle:@"Act" action:@selector(act:) keyEquivalent:@""] autorelease];
    act.target = target;
    [context addItem:act];
    content.menu = context;
    BOOL tracked = NO;
    whileTracking(context, @"context menu", YES, &tracked, ^{
        NSWindow *shown = menuWindow(window);
        note([NSString stringWithFormat:@"context menu: %@", shown ? panelFacts(shown) : @"no menu window of the application"]);
        if (!shown) return;
        // A person moves the pointer with the button held onto the item, which highlights it, and releases it there.
        NSPoint item = pointOfScreenRect(window, shown.frame);
        sp_input_result drag = sp_input_pointer_clicks(window, item.x, item.y, 2, 1, 1);
        sp_input_result up = sp_input_pointer_clicks(window, item.x, item.y, 3, 1, 1);
        note([NSString stringWithFormat:@"context menu: drag onto the item %s, release over it %s at %@", resultText(drag),
            resultText(up), NSStringFromPoint(item)]);
    });
    NSDate *menuStart = NSDate.date;
    sp_input_result down = sp_input_pointer_clicks(window, 300, 200, 1, 1, 1);
    note([NSString stringWithFormat:@"context menu: right press %s", resultText(down)]);
    settle(@"the context menu input is handled");
    check(tracked, @"a right press of the window opens its context menu");
    check(target.runs == 1, [NSString stringWithFormat:@"the release over the item of a context menu runs the item (runs %ld)", (long)target.runs]);
    if (target.runs != 1) noteMenuTracking(menuStart, @"context menu");
    content.menu = nil;

    // The menu of a pop-up button: a press opens it, Down Arrow moves to the next item and Return chooses it.
    NSPopUpButton *popup = [[[NSPopUpButton alloc] initWithFrame:NSMakeRect(40, 40, 180, 26) pullsDown:NO] autorelease];
    [popup addItemsWithTitles:@[@"One", @"Two", @"Three"]];
    [popup selectItemAtIndex:0];
    popup.target = target;
    popup.action = @selector(choose:);
    [content addSubview:popup];
    NSPoint at = pointOf(window, popup);
    tracked = NO;
    whileTracking(popup.menu, @"pop-up menu", NO, &tracked, ^{
        sp_input_result up = sp_input_pointer_clicks(window, at.x, at.y, 3, 0, 1);
        note([NSString stringWithFormat:@"pop-up menu: release on the button %s", resultText(up)]);
        key(window, "ArrowDown", @"pop-up menu");
        key(window, "Enter", @"pop-up menu");
    });
    down = sp_input_pointer_clicks(window, at.x, at.y, 1, 0, 1);
    note([NSString stringWithFormat:@"pop-up menu: press %s", resultText(down)]);
    settle(@"the pop-up menu input is handled");
    check(tracked, @"a press of a pop-up button opens its menu");
    // The action of the pop-up button runs only for an item that the menu chose, and not for the end of the tracking by the test.
    NSString *chose = [NSString stringWithFormat:
        @"Down Arrow and Return in the menu of a pop-up button choose the next item (chosen %@, selected %ld)", target.chosen,
        (long)popup.indexOfSelectedItem];
    // The keys reach the tracking menu on macOS 27. On macOS 15 they reach no window while the menu tracks, and no machine of
    // macOS 15 to 26 is at hand to find the delivery that reaches it there, so the judgment holds below macOS 27 (F756-5).
    if ([NSProcessInfo.processInfo isOperatingSystemAtLeastVersion:(NSOperatingSystemVersion){27, 0, 0}]) {
        check([target.chosen isEqualToString:@"Two"], chose);
    } else {
        printf("  HELD: %s: no judgment below macOS 27 (F756-5)\n", chose.UTF8String);
    }

    // The open and save panels show their content from a service of the system (NSRemoteView), which takes no forwarded key other
    // than a command equivalent and no forwarded press. Such a panel is the person's: every key, text and pointer input of it is
    // refused in its turn with the reason, and the panel stays; a check answers the dialogs of a window through host.dialog.
    NSString *folder = temporaryFolder(@"soksak-input-panels-");
    NSSavePanel *save = [NSSavePanel savePanel];
    save.directoryURL = [NSURL fileURLWithPath:folder];
    save.nameFieldStringValue = @"untitled";
    NSOpenPanel *open = [NSOpenPanel openPanel];
    open.directoryURL = [NSURL fileURLWithPath:folder];
    for (NSSavePanel *panel in @[save, open]) {
        NSString *kind = panel == open ? @"an open panel" : @"a save panel";
        __block NSModalResponse ended = NOT_ENDED;
        [panel beginSheetModalForWindow:window completionHandler:^(NSModalResponse returned) { ended = returned; }];
        eventWait([kind stringByAppendingString:@" sheet shows"], ^BOOL { return window.attachedSheet != nil && window.attachedSheet.isVisible; });
        NSWindow *sheet = window.attachedSheet;
        note([NSString stringWithFormat:@"%@: %@", kind, panelFacts(sheet)]);
        NSPoint middle = pointOfScreenRect(window, sheet.frame);
        struct { const char *name, *text; unsigned modifiers; } inputs[] = {
            {"Enter", NULL, 0}, {"Escape", NULL, 0}, {"Backspace", NULL, 0}, {"t", "t", 0}, {"Tab", NULL, 0}, {"a", "a", 8},
        };
        for (size_t i = 0; i < sizeof(inputs) / sizeof(inputs[0]); i++) {
            const char *name = inputs[i].name, *text = inputs[i].text;
            unsigned modifiers = inputs[i].modifiers;
            __block sp_input_result down = SP_INPUT_DELIVERED;
            NSString *records = capturedRecords(^{ down = sp_input_key(window, name, text, modifiers, true); });
            sp_input_result up = sp_input_key(window, name, text, modifiers, false);
            check(down == SP_INPUT_REJECTED && up == SP_INPUT_REJECTED && [records containsString:@"host.dialog"],
                [NSString stringWithFormat:@"the key %s of %@ is refused with the reason (results %s, %s, records %@)", name, kind,
                    resultText(down), resultText(up), records]);
        }
        check(sp_input_text(window, SP_INPUT_TEXT_INSERT, "typed", 0, 0, -1, 0) == SP_INPUT_REJECTED,
            [NSString stringWithFormat:@"a text of %@ is refused", kind]);
        check(sp_input_text(window, SP_INPUT_TEXT_MARK, "t", 0, 1, -1, 0) == SP_INPUT_REJECTED,
            [NSString stringWithFormat:@"a composition of %@ is refused", kind]);
        check(sp_input_pointer_clicks(window, middle.x, middle.y, 1, 0, 1) == SP_INPUT_REJECTED,
            [NSString stringWithFormat:@"a press of the content of %@ is refused", kind]);
        settle([kind stringByAppendingString:@": the refused input is handled"]);
        check(ended == NOT_ENDED && window.attachedSheet == sheet && (panel == open || [save.nameFieldStringValue isEqualToString:@"untitled"]),
            [NSString stringWithFormat:@"%@ stays as it was after the refused input (response %ld)", kind, (long)ended]);
        // The test ends the panel as the person's Cancel does.
        [panel cancel:nil];
        eventWait([kind stringByAppendingString:@" ends"], ^BOOL { return ended != NOT_ENDED; });
    }
    tracing = NO;
    removeTemporaryFolder(folder);

    check(!NSRunningApplication.currentApplication.active, @"the input left the application inactive");
    [cover close];
    [window close];
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
} }
