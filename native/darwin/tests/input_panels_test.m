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
// last: the service of the panel answers their completion through a connection, so they wait for it.
#import <Cocoa/Cocoa.h>
#import <OSLog/OSLog.h>
#import <objc/runtime.h>
#import "input_inject.h"
#import "input_virtual.h"
#import "support/event_wait.h"
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
static void noteMenuTracking(NSDate *since, NSString *what) {
    NSError *error = nil;
    OSLogStore *store = [OSLogStore storeWithScope:OSLogStoreCurrentProcessIdentifier error:&error];
    OSLogEnumerator *entries = [store entriesEnumeratorWithOptions:0 position:[store positionWithDate:since]
        predicate:[NSPredicate predicateWithFormat:@"subsystem == 'com.apple.AppKit' AND category CONTAINS[c] 'Menu'"] error:&error];
    if (!entries) { note([NSString stringWithFormat:@"%@: the log of the process cannot be read: %@", what, error]); return; }
    for (OSLogEntry *entry in entries) note([NSString stringWithFormat:@"%@: AppKit %@", what, entry.composedMessage]);
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
        case NSEventTypeKeyDown: return [@"key down " stringByAppendingString:event.charactersIgnoringModifiers ?: @""];
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
static void key(NSWindow *window, const char *name, NSString *what) {
    sp_input_result down = sp_input_key(window, name, NULL, 0, true);
    sp_input_result up = sp_input_key(window, name, NULL, 0, false);
    note([NSString stringWithFormat:@"%@: key %s down %s, up %s", what, name, resultText(down), resultText(up)]);
}

// The screen frame of the button titled title in the accessibility tree of element, or an empty rect.
static NSRect accessibleButton(id element, NSString *title) {
    if ([[element accessibilityRole] isEqualToString:NSAccessibilityButtonRole]
        && ([[element accessibilityTitle] isEqualToString:title] || [[element accessibilityLabel] isEqualToString:title])) {
        return [element accessibilityFrame];
    }
    for (id child in [element accessibilityChildren] ?: @[]) {
        NSRect found = accessibleButton(child, title);
        if (!NSIsEmptyRect(found)) return found;
    }
    return NSZeroRect;
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

// Runs attempt once the menu tracks, and ends the tracking after the events that attempt queued were handled: the tracking reads
// the queued events before the run loop runs a block of the main queue.
static void whileTracking(NSMenu *menu, NSString *what, BOOL *tracked, void (^attempt)(void)) {
    __block id observer = [NSNotificationCenter.defaultCenter addObserverForName:NSMenuDidBeginTrackingNotification object:menu
        queue:nil usingBlock:^(NSNotification *note_) {
            [NSNotificationCenter.defaultCenter removeObserver:observer];
            *tracked = YES;
            dispatch_async(dispatch_get_main_queue(), ^{
                attempt();
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
    click(window, pointOf(window, alert.buttons[0]), 0, @"alert sheet");
    settle(@"the press of the alert is handled");
    check(response == NSAlertFirstButtonReturn,
        [NSString stringWithFormat:@"a press of the first button of an alert sheet ends it with that button (response %ld)", (long)response]);
    endSheet(window, @"alert sheet press");

    // Return presses the default button of the alert sheet, and Escape its cancel button.
    alert = showAlert(window, &response);
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
    whileTracking(context, @"context menu", &tracked, ^{
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
    whileTracking(popup.menu, @"pop-up menu", &tracked, ^{
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
    check([target.chosen isEqualToString:@"Two"], [NSString stringWithFormat:
        @"Down Arrow and Return in the menu of a pop-up button choose the next item (chosen %@, selected %ld)", target.chosen,
        (long)popup.indexOfSelectedItem]);

    // The open and save panels show their content from a service of the system (NSRemoteView), which answers the panel of the
    // application through a connection, so a panel case waits for the completion of its sheet, with no limit: the limit of the
    // test ends a wait whose input did not reach the panel, and these cases come last.
    NSString *folder = temporaryFolder(@"soksak-input-panels-");

    // A save panel sheet takes a typed file name, and Return saves under it.
    NSSavePanel *save = [NSSavePanel savePanel];
    save.directoryURL = [NSURL fileURLWithPath:folder];
    save.nameFieldStringValue = @"untitled";
    __block NSModalResponse saved = NOT_ENDED;
    [save beginSheetModalForWindow:window completionHandler:^(NSModalResponse returned) { saved = returned; }];
    eventWait(@"the save panel sheet shows", ^BOOL { return window.attachedSheet != nil && window.attachedSheet.isVisible; });
    note([@"save panel: " stringByAppendingString:panelFacts(window.attachedSheet)]);
    // The panel selects the name when it shows, so the typed name replaces it.
    for (NSString *letter in @[@"t", @"y", @"p", @"e", @"d"]) key(window, letter.UTF8String, @"save panel name");
    key(window, "Enter", @"save panel");
    eventWait(@"the save panel ends", ^BOOL { return saved != NOT_ENDED; });
    check(saved == NSModalResponseOK && [save.URL.lastPathComponent isEqualToString:@"typed"], [NSString stringWithFormat:
        @"a typed name and Return end a save panel sheet with OK and that name (response %ld, URL %@)", (long)saved, save.URL]);

    // A press of the Cancel button of a save panel sheet cancels it. The button is found through the accessibility of the panel,
    // which the service of the panel serves for its content.
    save = [NSSavePanel savePanel];
    save.directoryURL = [NSURL fileURLWithPath:folder];
    saved = NOT_ENDED;
    [save beginSheetModalForWindow:window completionHandler:^(NSModalResponse returned) { saved = returned; }];
    eventWait(@"the save panel sheet shows again", ^BOOL { return window.attachedSheet != nil && window.attachedSheet.isVisible; });
    NSRect cancel = accessibleButton(window.attachedSheet, @"Cancel");
    note([NSString stringWithFormat:@"save panel: its Cancel button %@", NSIsEmptyRect(cancel) ? @"is not found"
        : [@"is at " stringByAppendingString:NSStringFromRect(cancel)]]);
    check(!NSIsEmptyRect(cancel), @"the Cancel button of a save panel sheet is found through its accessibility");
    if (!NSIsEmptyRect(cancel)) {
        click(window, pointOfScreenRect(window, cancel), 0, @"save panel");
        eventWait(@"the pressed save panel ends", ^BOOL { return saved != NOT_ENDED; });
        check(saved == NSModalResponseCancel,
            [NSString stringWithFormat:@"a press of the Cancel button of a save panel sheet cancels it (response %ld)", (long)saved]);
    }
    endSheet(window, @"save panel press");

    // An open panel sheet: Escape cancels it.
    NSOpenPanel *open = [NSOpenPanel openPanel];
    open.directoryURL = [NSURL fileURLWithPath:folder];
    __block NSModalResponse opened = NOT_ENDED;
    [open beginSheetModalForWindow:window completionHandler:^(NSModalResponse returned) { opened = returned; }];
    eventWait(@"the open panel sheet shows", ^BOOL { return window.attachedSheet != nil && window.attachedSheet.isVisible; });
    note([@"open panel: " stringByAppendingString:panelFacts(window.attachedSheet)]);
    key(window, "Escape", @"open panel");
    eventWait(@"the open panel ends", ^BOOL { return opened != NOT_ENDED; });
    check(opened == NSModalResponseCancel,
        [NSString stringWithFormat:@"Escape cancels an open panel sheet (response %ld)", (long)opened]);

    check(!NSRunningApplication.currentApplication.active, @"the input left the application inactive");
    [cover close];
    [window close];
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
} }
