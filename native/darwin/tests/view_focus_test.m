// Checks that a mouse press on a view (docs/spec/native-surfaces.md#view-surfaces) reaches the page of the view and moves the
// keyboard focus of the window into the view, so the keys that the person types after the click reach the view. The press is
// sent through -[NSWindow sendEvent:], the entry point of AppKit for a mouse event, and the application is not activated.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "support/temporary_folder.h"
#import "support/view_import_map.h"
#import "document_view.h"
#import "private/webkit.h"
#import "webview_geometry.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Runs the main run loop until done returns YES or 10 seconds pass, and returns the result of done.
static BOOL waitFor(BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    return done();
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
    "document.addEventListener('mousedown', () => { document.title = 'down'; }, true);</script>";

static NSEvent *mouseEvent(NSWindow *window, NSEventType type, NSPoint point, NSInteger clicks, float pressure) {
    return [NSEvent mouseEventWithType:type location:[window.contentView convertPoint:point toView:nil] modifierFlags:0
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil eventNumber:0
        clickCount:clicks pressure:pressure];
}

int main(void) { @autoreleasepool {
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
    check(sp_document_load(view, "sok://probe/ui/page.html"), @"the view loads the page of its plugin");
    if (!waitFor(^BOOL { return [latest[@"title"] isEqual:@"ready"]; })) {
        fprintf(stderr, "FAIL: the view page did not load within 10 seconds\n");
        return 1;
    }

    // The keyboard focus starts in the app DOM, so a change of the first responder is observable.
    check([window makeFirstResponder:main], @"the app DOM takes the keyboard focus before the press");

    // The press and the release are at the center of the view, which is inside the text field of the view page.
    [window sendEvent:mouseEvent(window, NSEventTypeLeftMouseDown, NSMakePoint(250, 200), 1, 1)];
    [window sendEvent:mouseEvent(window, NSEventTypeLeftMouseUp, NSMakePoint(250, 200), 1, 0)];
    check(waitFor(^BOOL { return [latest[@"title"] isEqual:@"down"]; }), @"the page of the view receives the press");

    NSResponder *responder = window.firstResponder;
    BOOL inView = responder == view || ([responder isKindOfClass:NSView.class] && [(NSView *)responder isDescendantOf:view]);
    check(inView,
        [NSString stringWithFormat:@"a press on the view moves the keyboard focus into the view (first responder %@)",
            NSStringFromClass(responder.class)]);

    sp_document_close(view);
    sp_surface_close(surface);
    [window close];
    [window release];
    return failures ? 1 : 0;
}}
