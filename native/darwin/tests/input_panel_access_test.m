// Checks whether the accessibility of this process reaches the content of a save panel and acts on it: a press of its Cancel
// button, and a name set into its name field followed by a press of its Save button. The content of an open or save panel is an
// NSRemoteView of a service of the system, which takes no forwarded key other than a command equivalent and no forwarded press,
// and its accessibility appears in the tree of this process as an element of the remote view (NSAccessibilityRemoteUIElement).
//
// Two paths are judged. The first reads the element of the remote view through NSAccessibility in this process. The second asks
// the accessibility API for the application element of this process (AXUIElementCreateApplication(getpid())), walks into the
// panel and performs AXPress or sets AXValue. That API answers through the main thread of the process it asks, so the walk runs
// on another thread while the main thread runs its run loop. The test notes whether the process is trusted for accessibility
// (AXIsProcessTrusted) and judges that the pointer of the person and the frontmost application stay the same. The window stands
// behind a window of its own that covers it, and the test process is never active.
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import "support/event_wait.h"
#import "support/temporary_folder.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}
static void note(NSString *message) { fprintf(stdout, "NOTE: %s\n", message.UTF8String); }

static const NSModalResponse NOT_ENDED = NSIntegerMin;

static NSString *personState(void) {
    CGEventRef now = CGEventCreate(NULL);
    CGPoint pointer = now ? CGEventGetLocation(now) : CGPointMake(NAN, NAN);
    if (now) CFRelease(now);
    return [NSString stringWithFormat:@"pointer %@, frontmost %@", NSStringFromPoint(NSPointFromCGPoint(pointer)),
        NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier];
}

static void judgePerson(NSString *before, NSString *what) {
    NSString *after = personState();
    check([after isEqualToString:before],
        [NSString stringWithFormat:@"%@: the pointer and the frontmost application stay (before %@, after %@)", what, before, after]);
}

// The facts of the element of the remote view that NSAccessibility answers in this process.
static void noteRemoteElement(NSWindow *panel) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    NSArray *children = [panel accessibilityAttributeValue:NSAccessibilityChildrenAttribute];
    for (id child in children) {
        NSArray *names = [child respondsToSelector:@selector(accessibilityAttributeNames)] ? [child accessibilityAttributeNames] : nil;
        NSArray *actions = [child respondsToSelector:@selector(accessibilityActionNames)] ? [child accessibilityActionNames] : nil;
        id grandchildren = [child respondsToSelector:@selector(accessibilityAttributeValue:)]
            ? [child accessibilityAttributeValue:NSAccessibilityChildrenAttribute] : nil;
        note([NSString stringWithFormat:@"remote element %@: attributes %@, actions %@, children %@", [child class], names, actions,
            grandchildren]);
    }
#pragma clang diagnostic pop
}

static NSString *stringAttribute(AXUIElementRef element, CFStringRef name) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess || !value) return nil;
    NSString *text = CFGetTypeID(value) == CFStringGetTypeID() ? [[(NSString *)value copy] autorelease] : nil;
    CFRelease(value);
    return text;
}

// The first element under element, depth first, for which match answers YES; retained, or NULL. Each error of the walk is noted.
static AXUIElementRef findElement(AXUIElementRef element, BOOL (^match)(AXUIElementRef), NSMutableArray *trail, int depth) {
    if (match(element)) return (AXUIElementRef)CFRetain(element);
    CFTypeRef children = NULL;
    AXError error = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &children);
    pid_t pid = 0;
    AXUIElementGetPid(element, &pid);
    [trail addObject:[NSString stringWithFormat:@"%*s%@ %@ pid %d: children error %d count %ld", depth * 2, "",
        stringAttribute(element, kAXRoleAttribute), stringAttribute(element, kAXTitleAttribute), pid, error,
        children ? (long)CFArrayGetCount(children) : -1]];
    if (error != kAXErrorSuccess || !children) return NULL;
    AXUIElementRef found = NULL;
    for (CFIndex i = 0; !found && i < CFArrayGetCount(children); i++) {
        found = findElement((AXUIElementRef)CFArrayGetValueAtIndex(children, i), match, trail, depth + 1);
    }
    CFRelease(children);
    return found;
}

static BOOL (^roleTitled(NSString *role, NSString *title))(AXUIElementRef) {
    return [[^BOOL(AXUIElementRef element) {
        return [stringAttribute(element, kAXRoleAttribute) isEqualToString:role]
            && (!title || [stringAttribute(element, kAXTitleAttribute) isEqualToString:title]);
    } copy] autorelease];
}

// Runs work on another thread, since the accessibility API of this process answers on the main thread, and runs the main run loop
// until work returns.
static void offMain(NSString *what, void (^work)(void)) {
    __block BOOL done = NO;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        @autoreleasepool { work(); }
        dispatch_async(dispatch_get_main_queue(), ^{ done = YES; });
    });
    eventWait(what, ^BOOL { return done; });
}

static NSSavePanel *showPanel(NSWindow *window, NSString *folder, NSModalResponse *response, NSString *what) {
    NSSavePanel *save = [NSSavePanel savePanel];
    save.directoryURL = [NSURL fileURLWithPath:folder];
    save.nameFieldStringValue = @"untitled";
    *response = NOT_ENDED;
    [save beginSheetModalForWindow:window completionHandler:^(NSModalResponse returned) { *response = returned; }];
    eventWait([what stringByAppendingString:@": the save panel sheet shows"], ^BOOL {
        return window.attachedSheet != nil && window.attachedSheet.isVisible;
    });
    return save;
}

int main(void) { @autoreleasepool {
    setvbuf(stdout, NULL, _IOLBF, 0);
    [NSApplication sharedApplication];
    [NSApp finishLaunching];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(160, 160, 640, 480)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    window.title = @"input panel access";
    [window orderBack:nil];
    NSWindow *cover = [[NSWindow alloc] initWithContentRect:NSMakeRect(140, 140, 700, 560)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    cover.releasedWhenClosed = NO;
    cover.backgroundColor = NSColor.grayColor;
    [cover orderWindow:NSWindowAbove relativeTo:window.windowNumber];
    check(!NSRunningApplication.currentApplication.active, @"the application is not active");
    note([NSString stringWithFormat:@"the process is trusted for accessibility: %d", AXIsProcessTrusted()]);
    NSString *folder = temporaryFolder(@"soksak-input-panel-access-");
    pid_t own = getpid();

    // A press of the Cancel button through the accessibility of this process cancels the panel.
    NSModalResponse response = NOT_ENDED;
    showPanel(window, folder, &response, @"press");
    noteRemoteElement(window.attachedSheet);
    NSString *before = personState();
    __block AXError pressError = kAXErrorFailure;
    __block BOOL pressFound = NO;
    __block NSArray *pressTrail = nil;
    offMain(@"press: the accessibility walk returns", ^{
        AXUIElementRef application = AXUIElementCreateApplication(own);
        NSMutableArray *trail = [NSMutableArray array];
        AXUIElementRef cancel = findElement(application, roleTitled((NSString *)kAXButtonRole, @"Cancel"), trail, 0);
        CFRelease(application);
        pressFound = cancel != NULL;
        if (cancel) {
            pressError = AXUIElementPerformAction(cancel, kAXPressAction);
            CFRelease(cancel);
        }
        pressTrail = [trail copy];
    });
    for (NSString *step in pressTrail) note([@"press walk: " stringByAppendingString:step]);
    [pressTrail release];
    check(pressFound, @"press: the Cancel button of the panel is found through the accessibility of this process");
    if (pressFound) {
        check(pressError == kAXErrorSuccess, [NSString stringWithFormat:@"press: AXPress of the Cancel button answers success (%d)",
            pressError]);
        judgePerson(before, @"press, the action performed");
        eventWait(@"the pressed save panel ends", ^BOOL { return response != NOT_ENDED; });
        judgePerson(before, @"press, the panel ended");
        check(response == NSModalResponseCancel,
            [NSString stringWithFormat:@"AXPress of the Cancel button cancels a save panel sheet (response %ld)", (long)response]);
    }
    if (window.attachedSheet) [window endSheet:window.attachedSheet returnCode:NSModalResponseAbort];
    eventWait(@"the pressed save panel is gone", ^BOOL { return window.attachedSheet == nil; });

    // A name set into the name field and a press of the Save button save under that name.
    response = NOT_ENDED;
    NSSavePanel *save = showPanel(window, folder, &response, @"name");
    before = personState();
    __block AXError valueError = kAXErrorFailure, saveError = kAXErrorFailure;
    __block BOOL fieldFound = NO, saveFound = NO;
    __block NSArray *nameTrail = nil;
    offMain(@"name: the accessibility walk returns", ^{
        AXUIElementRef application = AXUIElementCreateApplication(own);
        NSMutableArray *trail = [NSMutableArray array];
        AXUIElementRef field = findElement(application, roleTitled((NSString *)kAXTextFieldRole, nil), trail, 0);
        fieldFound = field != NULL;
        if (field) {
            valueError = AXUIElementSetAttributeValue(field, kAXValueAttribute, CFSTR("typed"));
            CFRelease(field);
        }
        AXUIElementRef button = findElement(application, roleTitled((NSString *)kAXButtonRole, @"Save"), trail, 0);
        saveFound = button != NULL;
        if (button) {
            saveError = AXUIElementPerformAction(button, kAXPressAction);
            CFRelease(button);
        }
        CFRelease(application);
        nameTrail = [trail copy];
    });
    for (NSString *step in nameTrail) note([@"name walk: " stringByAppendingString:step]);
    [nameTrail release];
    check(fieldFound && saveFound, [NSString stringWithFormat:
        @"name: the name field (%d) and the Save button (%d) are found through the accessibility of this process", fieldFound, saveFound]);
    if (fieldFound && saveFound) {
        check(valueError == kAXErrorSuccess && saveError == kAXErrorSuccess, [NSString stringWithFormat:
            @"name: setting AXValue (%d) and AXPress of Save (%d) answer success", valueError, saveError]);
        judgePerson(before, @"name, the actions performed");
        eventWait(@"the named save panel ends", ^BOOL { return response != NOT_ENDED; });
        judgePerson(before, @"name, the panel ended");
        check(response == NSModalResponseOK && [save.URL.lastPathComponent isEqualToString:@"typed"], [NSString stringWithFormat:
            @"AXValue and AXPress save a save panel sheet under the set name (response %ld, URL %@)", (long)response, save.URL]);
    }
    if (window.attachedSheet) [window endSheet:window.attachedSheet returnCode:NSModalResponseAbort];
    check(!NSRunningApplication.currentApplication.active, @"the application is still not active");
    return failures ? 1 : 0;
} }
