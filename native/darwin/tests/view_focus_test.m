// Checks that a mouse press on a view (docs/spec/native-surfaces.md#view-surfaces) reaches the page and moves keyboard focus
// into the view. The default path sends a press through -[NSWindow sendEvent:] without activating the application. The
// --activation path activates the application first and checks that the page also receives a key event.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "support/temporary_folder.h"
#import "support/view_import_map.h"
#import "document_view.h"
#import "private/webkit.h"
#import "webview_geometry.h"
#import "input_inject.h"

// Declared by the activation checks of make test-activation (tests/support/no_activation.m).
void sp_test_declare_activation(void);

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Runs the main run loop until done returns YES or 10 seconds pass, and returns the result of done.
static BOOL waitForWithin(BOOL (^done)(void), NSTimeInterval timeoutSeconds) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeoutSeconds];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
            untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01] inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
    }
    return done();
}

static BOOL waitFor(BOOL (^done)(void)) {
    return waitForWithin(done, 10);
}

static void applicationEventPumpTest(void) {
    const NSInteger subtype = 23995;
    __block BOOL delivered = NO;
    id monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskApplicationDefined
        handler:^NSEvent *(NSEvent *event) {
            if (event.subtype == subtype) delivered = YES;
            return event;
        }];
    NSEvent *event = [NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint
        modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:0 context:nil
        subtype:(short)subtype data1:1 data2:0];
    [NSApp postEvent:event atStart:NO];
    BOOL processed = waitForWithin(^BOOL { return delivered; }, 0.1);
    [NSEvent removeMonitor:monitor];
    check(processed, @"waitFor dispatches a queued AppKit application event");
}

static NSDictionary *latest;

static void changed(void *context, const char *text) {
    (void)context;
    latest = [[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:text length:strlen(text)] options:0 error:nil] retain];
}

static void writeFile(NSString *root, NSString *path, NSString *text) {
    NSString *file = [root stringByAppendingPathComponent:path];
    [[NSFileManager defaultManager] createDirectoryAtPath:file.stringByDeletingLastPathComponent
        withIntermediateDirectories:YES attributes:nil error:nil];
    [text writeToFile:file atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

// The channel script of a view configuration, as the host adds it to every view.
static NSString *const channelScript = @"window.webkit.messageHandlers['sok-view'].postMessage("
    "{ event: 'view.ready', plugin: 'probe', document: 'doc-1' });";

// A page whose body is one text field that fills the view. The title reports that the page has loaded, and that the page
// received a mouse down.
static NSString *const page = @"<!doctype html><meta charset=utf-8><title>loading</title>"
    "<input id='field' style='position:absolute;left:0;top:0;width:100%;height:100%;font-size:24px;border:0'>"
    "<script>document.title = 'ready';"
    "document.addEventListener('mousedown', () => { document.title = 'down'; }, true);"
    "document.addEventListener('keydown', (e) => { document.title = 'key:' + e.key; }, true);</script>";

static BOOL activationDone;
static sp_activate_result activationResult;
static NSString *activationFrontmost;

@interface TestRunningApplication : NSObject
- (instancetype)initWithProcessIdentifier:(pid_t)processIdentifier;
- (pid_t)processIdentifier;
@end

@implementation TestRunningApplication {
    pid_t _processIdentifier;
}
- (instancetype)initWithProcessIdentifier:(pid_t)processIdentifier {
    self = [super init];
    if (self) _processIdentifier = processIdentifier;
    return self;
}
- (pid_t)processIdentifier { return _processIdentifier; }
@end

typedef BOOL (^ActivateFrontmost)(pid_t);
typedef BOOL (^WaitForActivationNotification)(BOOL (^)(void));

static void storeActivationResult(sp_activate_result result, NSString *frontmost) {
    NSString *snapshot = [frontmost retain];
    [activationFrontmost release];
    activationResult = result;
    activationFrontmost = snapshot;
    activationDone = YES;
}

static void clearActivationFrontmost(void) {
    [activationFrontmost release];
    activationFrontmost = nil;
}

@interface TestActivationDescription : NSString {
    BOOL *_deallocated;
}
- (instancetype)initWithDeallocatedFlag:(BOOL *)deallocated;
@end

@implementation TestActivationDescription
- (instancetype)initWithDeallocatedFlag:(BOOL *)deallocated {
    self = [super init];
    if (self) _deallocated = deallocated;
    return self;
}
- (NSUInteger)length { return 1; }
- (unichar)characterAtIndex:(NSUInteger)index {
    if (index != 0) [NSException raise:NSRangeException format:@"index out of range"];
    return 'x';
}
- (void)dealloc {
    if (_deallocated) *_deallocated = YES;
    [super dealloc];
}
@end

typedef NSString *(*ActivationDescriptionFactory)(const char *);
static ActivationDescriptionFactory activationDescriptionFactory;
static BOOL *activationDescriptionDeallocated;

static NSString *defaultActivationDescription(const char *frontmost) {
    return [NSString stringWithUTF8String:frontmost];
}

static NSString *shortLivedActivationDescription(const char *frontmost) {
    if (!frontmost || strcmp(frontmost, "frontmost.test") != 0) return nil;
    return [[[TestActivationDescription alloc] initWithDeallocatedFlag:activationDescriptionDeallocated] autorelease];
}

static void activationReported(void *context, sp_activate_result result, const char *frontmost) {
    (void)context;
    ActivationDescriptionFactory factory = activationDescriptionFactory ?: defaultActivationDescription;
    storeActivationResult(result, frontmost ? factory(frontmost) : nil);
}

static void activationDescriptionLifetimeTest(void) {
    BOOL deallocated = NO;
    activationDone = NO;
    activationResult = SP_ACTIVATE_PENDING;
    clearActivationFrontmost();
    activationDescriptionDeallocated = &deallocated;
    ActivationDescriptionFactory previousFactory = activationDescriptionFactory;
    activationDescriptionFactory = shortLivedActivationDescription;
    @autoreleasepool {
        activationReported(NULL, SP_ACTIVATE_REFUSED, "frontmost.test");
    }
    activationDescriptionFactory = previousFactory;
    activationDescriptionDeallocated = NULL;
    check(activationDone && activationResult == SP_ACTIVATE_REFUSED,
        @"the activation callback records the refusal result");
    BOOL retained = !deallocated;
    check(retained, @"the saved frontmost description survives the callback autorelease pool");
    if (retained) {
        clearActivationFrontmost();
        check(deallocated, @"the saved frontmost description is released by its owner");
    } else {
        // The unchanged implementation leaves a dangling pointer after the inner pool drains.
        activationFrontmost = nil;
    }
    activationDone = NO;
    activationResult = SP_ACTIVATE_PENDING;
}

static BOOL activateAndObserveFrontmostPID(pid_t targetPID, NSNotificationCenter *center,
    ActivateFrontmost activate, WaitForActivationNotification waitForNotification) {
    __block BOOL observed = NO;
    id observer = [center addObserverForName:NSWorkspaceDidActivateApplicationNotification object:nil queue:nil
        usingBlock:^(NSNotification *notification) {
            id application = notification.userInfo[NSWorkspaceApplicationKey];
            if ([application respondsToSelector:@selector(processIdentifier)]
                && [application processIdentifier] == targetPID) observed = YES;
        }];
    BOOL requested = activate(targetPID);
    BOOL restored = requested && waitForNotification(^BOOL { return observed; });
    [center removeObserver:observer];
    return restored;
}

static BOOL restoreFrontmostUsing(pid_t previousPID, BOOL activationAttempted, pid_t currentFrontmostPID,
    ActivateFrontmost activate, NSNotificationCenter *center, WaitForActivationNotification waitForNotification) {
    if (!activationAttempted) return YES;
    if (previousPID <= 0) return NO;
    if (currentFrontmostPID == previousPID) return YES;
    return activateAndObserveFrontmostPID(previousPID, center, activate, waitForNotification);
}

static BOOL restoreFrontmost(NSRunningApplication *previous, BOOL activationAttempted) {
    if (!activationAttempted) return YES;
    pid_t previousPID = previous.processIdentifier;
    pid_t currentFrontmostPID = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    BOOL restored = restoreFrontmostUsing(previousPID, YES, currentFrontmostPID,
        ^BOOL(pid_t previousPID) { (void)previousPID; return [previous activateWithOptions:0]; },
        NSWorkspace.sharedWorkspace.notificationCenter,
        ^BOOL(BOOL (^condition)(void)) {
            NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
            NSRunLoop *runLoop = NSRunLoop.currentRunLoop;
            while (!condition() && deadline.timeIntervalSinceNow > 0) {
                [runLoop runMode:NSDefaultRunLoopMode beforeDate:deadline];
            }
            return condition();
        });
    pid_t actual = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    check(restored,
        [NSString stringWithFormat:@"the previous frontmost application is restored (expected pid %d, got %d)",
            previousPID, actual]);
    return restored;
}

static int frontmostRestoreTest(void) {
    [NSApplication sharedApplication];
    applicationEventPumpTest();
    activationDescriptionLifetimeTest();
    __block NSUInteger waits = 0;
    __block NSUInteger activationRequests = 0;
    NSNotificationCenter *center = [[[NSNotificationCenter alloc] init] autorelease];
    BOOL inactive = restoreFrontmostUsing(100, NO, 200,
        ^BOOL(pid_t previousPID) { (void)previousPID; activationRequests++; return YES; }, center,
        ^BOOL(BOOL (^condition)(void)) { waits++; return condition(); });
    check(inactive, @"frontmost restoration is a no-op when activation was not attempted");
    check(activationRequests == 0 && waits == 0, @"the non-activation path neither requests activation nor observes restoration");

    waits = 0;
    BOOL refused = restoreFrontmostUsing(100, YES, 200,
        ^BOOL(pid_t previousPID) { (void)previousPID; activationRequests++; return NO; }, center,
        ^BOOL(BOOL (^condition)(void)) { waits++; return condition(); });
    check(!refused, @"frontmost restoration fails when activation is refused");
    check(waits == 0, @"frontmost notification wait is skipped when activation is refused");

    waits = 0;
    __block BOOL observedBeforeRequest = NO;
    BOOL unrelated = restoreFrontmostUsing(100, YES, 200,
        ^BOOL(pid_t previousPID) {
            activationRequests++;
            [center postNotification:[NSNotification notificationWithName:NSWorkspaceDidActivateApplicationNotification object:nil
                userInfo:@{ NSWorkspaceApplicationKey: [[[TestRunningApplication alloc] initWithProcessIdentifier:200] autorelease] }]];
            return YES;
        }, center, ^BOOL(BOOL (^condition)(void)) {
            waits++;
            observedBeforeRequest = !condition();
            return NO;
        });
    check(!unrelated, @"an unrelated process activation does not satisfy restoration");
    check(observedBeforeRequest, @"the notification handler ignores an unrelated process id");
    check(waits == 1, @"restoration waits after an unrelated activation notification");

    waits = 0;
    __block BOOL exactNotificationDuringRequest = NO;
    BOOL restored = restoreFrontmostUsing(100, YES, 200,
        ^BOOL(pid_t previousPID) {
            activationRequests++;
            [center postNotification:[NSNotification notificationWithName:NSWorkspaceDidActivateApplicationNotification object:nil
                userInfo:@{ NSWorkspaceApplicationKey: [[[TestRunningApplication alloc] initWithProcessIdentifier:previousPID] autorelease] }]];
            return YES;
        }, center, ^BOOL(BOOL (^condition)(void)) {
            waits++;
            exactNotificationDuringRequest = condition();
            return exactNotificationDuringRequest;
        });
    check(restored, @"frontmost restoration succeeds when the previous process is observed");
    check(exactNotificationDuringRequest, @"the observer is registered before the activation request");

    waits = 0;
    BOOL timeout = restoreFrontmostUsing(100, YES, 200,
        ^BOOL(pid_t previousPID) { (void)previousPID; activationRequests++; return YES; }, center,
        ^BOOL(BOOL (^condition)(void)) { waits++; return NO; });
    check(!timeout, @"frontmost restoration fails when no activation notification arrives");
    check(waits == 1, @"frontmost restoration applies its bounded notification wait");

    waits = 0;
    BOOL alreadyFrontmost = restoreFrontmostUsing(100, YES, 100,
        ^BOOL(pid_t previousPID) { (void)previousPID; activationRequests++; return YES; }, center,
        ^BOOL(BOOL (^condition)(void)) { waits++; return condition(); });
    check(alreadyFrontmost, @"frontmost restoration succeeds when the prior process is already frontmost");
    check(waits == 0, @"an already-frontmost prior process needs no activation or notification wait");

    BOOL invalidTarget = restoreFrontmostUsing(0, YES, 200,
        ^BOOL(pid_t previousPID) { (void)previousPID; activationRequests++; return YES; }, center,
        ^BOOL(BOOL (^condition)(void)) { (void)condition; waits++; return YES; });
    check(!invalidTarget, @"frontmost restoration fails when no prior process was captured");
    return failures ? 1 : 0;
}

static NSEvent *mouseEvent(NSWindow *window, NSEventType type, NSPoint point, NSInteger clicks, float pressure) {
    return [NSEvent mouseEventWithType:type location:[window.contentView convertPoint:point toView:nil] modifierFlags:0
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil eventNumber:0
        clickCount:clicks pressure:pressure];
}

int main(int argc, char **argv) { @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--frontmost-restore-test") == 0) return frontmostRestoreTest();
    BOOL activation = argc == 2 && strcmp(argv[1], "--activation") == 0;
    if (activation) sp_test_declare_activation();
    NSRunningApplication *previous = NSWorkspace.sharedWorkspace.frontmostApplication;
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSString *temporary = temporaryFolder(@"soksak-view-focus-");
    sp_view_import_map_set(viewImportMapFixture().UTF8String);
    NSString *folder = [temporary stringByAppendingPathComponent:@"plugin"];
    writeFile(folder, @"ui/page.html", page);

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    [window orderBack:nil];
    void *surface = sp_surface_create(main);
    webviewSetFrame(surface, 0, 0, 500, 400);
    NSString *store = [temporary stringByAppendingPathComponent:@"store"];

    WKWebView *view = (WKWebView *)sp_document_create(surface, store.fileSystemRepresentation, folder.fileSystemRepresentation,
        "probe", channelScript.UTF8String, changed, NULL);
    check(view != NULL, @"a view is created on the surface");
    if (!view) return 1;
    // Both hosts place a wanted view while its surface is hidden for layout preparation, then reveal the surface at presentation.
    sp_document_place(view, 0, 0, 0, 0, true);
    check(view.hidden, @"a view placed during preparation stays hidden with its surface");
    webviewSetSurfaceHidden(surface, false);
    double frame[5] = {0};
    sp_document_frame(view, frame);
    check(frame[4] == 1, @"revealing the surface reveals its wanted view");

    // A later preparation must restore the view too, while an explicitly hidden view remains hidden.
    webviewSetSurfaceHidden(surface, true);
    sp_document_place(view, 0, 0, 0, 0, false);
    webviewSetSurfaceHidden(surface, false);
    sp_document_frame(view, frame);
    check(frame[4] == 0, @"revealing the surface keeps an explicitly hidden view hidden");
    webviewSetSurfaceHidden(surface, true);
    sp_document_place(view, 0, 0, 0, 0, true);
    webviewSetSurfaceHidden(surface, false);
    sp_document_frame(view, frame);
    check(frame[4] == 1, @"a later presentation restores the wanted view");
    latest = nil;
    check(sp_document_load(view, "soksak://probe/ui/page.html"), @"the view loads the page of its plugin");
    if (!waitFor(^BOOL { return [latest[@"title"] isEqual:@"ready"]; })) {
        fprintf(stderr, "FAIL: the view page did not load within 10 seconds\n");
        restoreFrontmost(previous, activation);
        return 1;
    }

    if (activation) {
        activationDone = NO;
        activationResult = SP_ACTIVATE_PENDING;
        activationFrontmost = nil;
        sp_input_activate(window, 5, activationReported, NULL);
        if (!waitFor(^BOOL { return activationDone; }) || activationResult != SP_ACTIVATE_DONE
            || !window.isKeyWindow || !NSApp.isActive) {
            fprintf(stderr, "FAIL: the application did not become active with the window key (activation %d, active %d, window key %d, frontmost %s)\n",
                activationResult, (int)NSApp.isActive, (int)window.isKeyWindow, activationFrontmost.UTF8String ?: "unknown");
            restoreFrontmost(previous, activation);
            clearActivationFrontmost();
            return 1;
        }
    }

    // The keyboard focus starts in the app DOM, so a change of the first responder is observable.
    check([window makeFirstResponder:main], @"the app DOM takes the keyboard focus before the press");

    // The press and the release are at the center of the view, which is inside the text field of the view page.
    [window sendEvent:mouseEvent(window, NSEventTypeLeftMouseDown, NSMakePoint(250, 200), 1, 1)];
    [window sendEvent:mouseEvent(window, NSEventTypeLeftMouseUp, NSMakePoint(250, 200), 1, 0)];
    check(waitFor(^BOOL { return [latest[@"title"] isEqual:@"down"]; }), @"the page of the view receives the press");
    if (activation) {
        NSTimeInterval time = NSProcessInfo.processInfo.systemUptime;
        [NSApp sendEvent:[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:time
            windowNumber:window.windowNumber context:nil characters:@"x" charactersIgnoringModifiers:@"x" isARepeat:NO keyCode:7]];
        [NSApp sendEvent:[NSEvent keyEventWithType:NSEventTypeKeyUp location:NSZeroPoint modifierFlags:0 timestamp:time
            windowNumber:window.windowNumber context:nil characters:@"x" charactersIgnoringModifiers:@"x" isARepeat:NO keyCode:7]];
        check(waitFor(^BOOL { return [latest[@"title"] isEqual:@"key:x"]; }),
            [NSString stringWithFormat:@"the page of the view receives the key x (title %@)", latest[@"title"]]);
    }

    NSResponder *responder = window.firstResponder;
    BOOL inView = responder == view || ([responder isKindOfClass:NSView.class] && [(NSView *)responder isDescendantOf:view]);
    check(inView,
        [NSString stringWithFormat:@"a press on the view moves the keyboard focus into the view (first responder %@)",
            NSStringFromClass(responder.class)]);

    sp_document_close(view);
    sp_surface_close(surface);
    [window close];
    [window release];
    restoreFrontmost(previous, activation);
    clearActivationFrontmost();
    return failures ? 1 : 0;
}}
