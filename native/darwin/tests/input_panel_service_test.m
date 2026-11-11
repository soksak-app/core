// Checks whether an event record that SkyLight sends to the service of a save panel (SLPSPostEventRecordTo) reaches the content of
// the panel: a press of its Cancel button and a Return. The content of an open or save panel is an NSRemoteView of a service of
// the system, and -[NSRemoteView mouseDown:] forwards no press to it, so emulated input reaches that content only through an
// event of the window server for the service process. SLPSPostEventRecordTo sends an encoded event record to the connection port
// of one process and asks no permission in the process (docs/operations/private-native-apis.md).
//
// The test sends records only to the process of the panel service, and only for the window of the panel. Each case judges that
// the position of the pointer of the person and the frontmost application are the same before and after the records, right after
// they are sent and again after the panel ended. The window of the test stands behind a window of its own that covers it, and the
// test process is never active. A panel that the records did not end keeps its wait until the limit of the test.
#import <Cocoa/Cocoa.h>
#import <libproc.h>
#import <dlfcn.h>
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
// The window number field of a CGEvent (docs/operations/private-native-apis.md), as input_inject.m sets it.
static const CGEventField windowNumberField = (CGEventField)51;
// The size of an event record of SkyLight, which SLEventGetEventRecord asserts.
enum { recordSize = 0xf8 };

static int (*getEventRecord)(CGEventRef event, void *record, size_t size);
static CGError (*postEventRecordTo)(ProcessSerialNumber *process, void *record);

static void loadSkyLight(void) {
    void *skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY | RTLD_NOLOAD);
    getEventRecord = skyLight ? (int (*)(CGEventRef, void *, size_t))dlsym(skyLight, "SLEventGetEventRecord") : NULL;
    postEventRecordTo = skyLight ? (CGError (*)(ProcessSerialNumber *, void *))dlsym(skyLight, "SLPSPostEventRecordTo") : NULL;
}

// The state of the person that a record must not change: the position of the pointer and the frontmost application.
static NSString *personState(void) {
    CGEventRef now = CGEventCreate(NULL);
    CGPoint pointer = now ? CGEventGetLocation(now) : CGPointMake(NAN, NAN);
    if (now) CFRelease(now);
    return [NSString stringWithFormat:@"pointer %@, frontmost %@", NSStringFromPoint(NSPointFromCGPoint(pointer)),
        NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier];
}

static NSString *pathOf(pid_t pid) {
    char path[PROC_PIDPATHINFO_MAXSIZE];
    return proc_pidpath(pid, path, sizeof(path)) > 0 ? [NSString stringWithUTF8String:path] : nil;
}

// The process of the service whose content the panel shows: the process that the NSRemoteView of the panel names.
static pid_t serviceOf(NSWindow *panel) {
    NSView *content = panel.contentView;
    SEL selector = NSSelectorFromString(@"viewServiceProcessIdentifier");
    if (![content respondsToSelector:selector]) return 0;
    return ((pid_t (*)(id, SEL))[content methodForSelector:selector])(content, selector);
}

// The window of service that shows the content of panel: the window of that process whose bounds hold the center of the panel.
static CGWindowID serviceWindowOf(pid_t service, NSWindow *panel) {
    NSArray *windows = [(NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID) autorelease];
    CGFloat top = NSMaxY(NSScreen.screens.firstObject.frame);
    CGPoint center = CGPointMake(NSMidX(panel.frame), top - NSMidY(panel.frame));
    for (NSDictionary *window in windows) {
        if ([window[(id)kCGWindowOwnerPID] intValue] != service) continue;
        CGRect bounds;
        if (!CGRectMakeWithDictionaryRepresentation((CFDictionaryRef)window[(id)kCGWindowBounds], &bounds)) continue;
        note([NSString stringWithFormat:@"service window %@ bounds %@ layer %@ on screen %@", window[(id)kCGWindowNumber],
            NSStringFromRect(NSRectFromCGRect(bounds)), window[(id)kCGWindowLayer], window[(id)kCGWindowIsOnscreen] ?: @NO]);
        if (CGRectContainsPoint(bounds, center)) return [window[(id)kCGWindowNumber] unsignedIntValue];
    }
    return kCGNullWindowID;
}

// Sends event as a record to the process service, for its window. Answers the error of SkyLight, or -1 when no record is made.
static CGError sendRecord(pid_t service, CGWindowID window, CGEventRef event) {
    CGEventSetIntegerValueField(event, windowNumberField, window);
    uint8_t record[recordSize] = {0};
    if (getEventRecord(event, record, sizeof(record)) != 0) return -1;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    ProcessSerialNumber process = {0, 0};
    if (GetProcessForPID(service, &process) != noErr) return -1;
#pragma clang diagnostic pop
    return postEventRecordTo(&process, record);
}

// An attribute of an accessibility element. The content of a panel of the system answers through an element of the remote view
// (NSAccessibilityRemoteUIElement), which answers only the attribute protocol (-accessibilityAttributeValue:), not the methods of
// NSAccessibility.
static id attribute(id element, NSAccessibilityAttributeName name) {
    if ([element respondsToSelector:@selector(accessibilityAttributeValue:)]) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        return [element accessibilityAttributeValue:name];
#pragma clang diagnostic pop
    }
    return nil;
}

// The screen frame (bottom-left origin) of the button titled title among element and its descendants, or an empty rect.
static NSRect accessibleButton(id element, NSString *title) {
    if ([attribute(element, NSAccessibilityRoleAttribute) isEqual:NSAccessibilityButtonRole]
        && ([attribute(element, NSAccessibilityTitleAttribute) isEqual:title]
            || [attribute(element, NSAccessibilityDescriptionAttribute) isEqual:title])) {
        NSValue *position = attribute(element, NSAccessibilityPositionAttribute);
        NSValue *size = attribute(element, NSAccessibilitySizeAttribute);
        if (![position isKindOfClass:NSValue.class] || ![size isKindOfClass:NSValue.class]) return NSZeroRect;
        // The position of the attribute protocol has its origin at the top left of the primary screen.
        CGFloat top = NSMaxY(NSScreen.screens.firstObject.frame);
        NSPoint origin = position.pointValue;
        return NSMakeRect(origin.x, top - origin.y - size.sizeValue.height, size.sizeValue.width, size.sizeValue.height);
    }
    id children = attribute(element, NSAccessibilityChildrenAttribute);
    for (id child in [children isKindOfClass:NSArray.class] ? children : @[]) {
        NSRect found = accessibleButton(child, title);
        if (!NSIsEmptyRect(found)) return found;
    }
    return NSZeroRect;
}

// Shows a save panel sheet over window and finds the process and the window of its service. Answers NO, with a FAIL, when the
// service is not the save panel service of the system or has no window of the panel: no record is sent then.
static BOOL showPanel(NSWindow *window, NSSavePanel *save, NSModalResponse *response, pid_t *service, CGWindowID *serviceWindow,
    NSString *what) {
    *response = NOT_ENDED;
    [save beginSheetModalForWindow:window completionHandler:^(NSModalResponse returned) { *response = returned; }];
    eventWait([what stringByAppendingString:@": the save panel sheet shows"], ^BOOL {
        return window.attachedSheet != nil && window.attachedSheet.isVisible;
    });
    NSWindow *panel = window.attachedSheet;
    *service = serviceOf(panel);
    NSString *path = *service > 0 ? pathOf(*service) : nil;
    note([NSString stringWithFormat:@"%@: panel %@ window %ld, content %@, service pid %d at %@", what, panel.class,
        (long)panel.windowNumber, panel.contentView.class, *service, path]);
    BOOL isService = *service > 0 && *service != getpid() && [path containsString:@"openAndSavePanelService"];
    check(isService, [what stringByAppendingString:@": the content of the panel names the save panel service of the system"]);
    if (!isService) return NO;
    *serviceWindow = serviceWindowOf(*service, panel);
    check(*serviceWindow != kCGNullWindowID,
        [NSString stringWithFormat:@"%@: the service has the window of the panel (%u)", what, *serviceWindow]);
    return *serviceWindow != kCGNullWindowID;
}

static void judgePerson(NSString *before, NSString *what) {
    NSString *after = personState();
    check([after isEqualToString:before],
        [NSString stringWithFormat:@"%@: the pointer and the frontmost application stay (before %@, after %@)", what, before, after]);
}

int main(void) { @autoreleasepool {
    setvbuf(stdout, NULL, _IOLBF, 0);
    [NSApplication sharedApplication];
    [NSApp finishLaunching];
    loadSkyLight();
    check(getEventRecord && postEventRecordTo, @"SkyLight has SLEventGetEventRecord and SLPSPostEventRecordTo");
    if (!getEventRecord || !postEventRecordTo) return 1;

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(160, 160, 640, 480)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    [window orderBack:nil];
    NSWindow *cover = [[NSWindow alloc] initWithContentRect:NSMakeRect(140, 140, 700, 560)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    cover.releasedWhenClosed = NO;
    cover.backgroundColor = NSColor.grayColor;
    [cover orderWindow:NSWindowAbove relativeTo:window.windowNumber];
    check(!NSRunningApplication.currentApplication.active, @"the application is not active");
    NSString *folder = temporaryFolder(@"soksak-input-panel-service-");

    // A press of the Cancel button of a save panel sheet, sent as a press and a release record to the service, cancels it.
    NSSavePanel *save = [NSSavePanel savePanel];
    save.directoryURL = [NSURL fileURLWithPath:folder];
    save.nameFieldStringValue = @"untitled";
    __block NSModalResponse saved = NOT_ENDED;
    pid_t service = 0;
    CGWindowID serviceWindow = kCGNullWindowID;
    if (showPanel(window, save, &saved, &service, &serviceWindow, @"press")) {
        NSRect cancel = accessibleButton(window.attachedSheet, @"Cancel");
        check(!NSIsEmptyRect(cancel), @"press: the Cancel button of the panel is found through its accessibility");
        if (!NSIsEmptyRect(cancel)) {
            CGFloat top = NSMaxY(NSScreen.screens.firstObject.frame);
            CGPoint point = CGPointMake(NSMidX(cancel), top - NSMidY(cancel));
            NSString *before = personState();
            CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, point, kCGMouseButtonLeft);
            CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, point, kCGMouseButtonLeft);
            CGEventSetIntegerValueField(down, kCGMouseEventClickState, 1);
            CGEventSetIntegerValueField(up, kCGMouseEventClickState, 1);
            CGError downError = sendRecord(service, serviceWindow, down);
            CGError upError = sendRecord(service, serviceWindow, up);
            CFRelease(down);
            CFRelease(up);
            note([NSString stringWithFormat:@"press: records at %@ sent, press %d, release %d",
                NSStringFromPoint(NSPointFromCGPoint(point)), downError, upError]);
            check(downError == kCGErrorSuccess && upError == kCGErrorSuccess, @"press: SkyLight sends the press and the release");
            judgePerson(before, @"press, the records sent");
            eventWait(@"the pressed save panel ends", ^BOOL { return saved != NOT_ENDED; });
            judgePerson(before, @"press, the panel ended");
            check(saved == NSModalResponseCancel,
                [NSString stringWithFormat:@"a press record of the Cancel button cancels a save panel sheet (response %ld)", (long)saved]);
        }
    }
    if (window.attachedSheet) [window endSheet:window.attachedSheet returnCode:NSModalResponseAbort];
    eventWait(@"the pressed save panel is gone", ^BOOL { return window.attachedSheet == nil; });

    // A Return, sent as a key down and a key up record to the service, saves under the name of the panel.
    save = [NSSavePanel savePanel];
    save.directoryURL = [NSURL fileURLWithPath:folder];
    save.nameFieldStringValue = @"untitled";
    saved = NOT_ENDED;
    if (showPanel(window, save, &saved, &service, &serviceWindow, @"Return")) {
        NSString *before = personState();
        CGEventRef down = CGEventCreateKeyboardEvent(NULL, 36, true);
        CGEventRef up = CGEventCreateKeyboardEvent(NULL, 36, false);
        CGEventSetFlags(down, 0);
        CGEventSetFlags(up, 0);
        CGError downError = sendRecord(service, serviceWindow, down);
        CGError upError = sendRecord(service, serviceWindow, up);
        CFRelease(down);
        CFRelease(up);
        note([NSString stringWithFormat:@"Return: records sent, key down %d, key up %d", downError, upError]);
        check(downError == kCGErrorSuccess && upError == kCGErrorSuccess, @"Return: SkyLight sends the key down and the key up");
        judgePerson(before, @"Return, the records sent");
        eventWait(@"the save panel ends on Return", ^BOOL { return saved != NOT_ENDED; });
        judgePerson(before, @"Return, the panel ended");
        check(saved == NSModalResponseOK && [save.URL.lastPathComponent isEqualToString:@"untitled"], [NSString stringWithFormat:
            @"a Return record saves a save panel sheet under its name (response %ld, URL %@)", (long)saved, save.URL]);
    }
    if (window.attachedSheet) [window endSheet:window.attachedSheet returnCode:NSModalResponseAbort];
    check(!NSRunningApplication.currentApplication.active, @"the application is still not active");
    return failures ? 1 : 0;
} }
