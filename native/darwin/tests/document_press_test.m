// Checks that the first press on a document region reaches its page (docs/spec/native-surfaces.md#document-regions):
// while another view of the window holds the keyboard focus, a native press and drag over text of the region document
// of an inactive application deliver the press to the page and select the text.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "document_view.h"
#import "input_inject.h"
#import "webview_geometry.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static NSDictionary *latest;

static void changed(void *context, const char *text) {
    (void)context;
    latest = [[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:text length:strlen(text)] options:0 error:nil] retain];
}

/** Runs the main run loop until done returns true; returns false after 10 seconds. */
static BOOL until(BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    return done();
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSString *temporary = [NSTemporaryDirectory() stringByAppendingPathComponent:
        [NSString stringWithFormat:@"soksak-document-press-%d", getpid()]];
    [[NSFileManager defaultManager] createDirectoryAtPath:temporary withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *page = [temporary stringByAppendingPathComponent:@"press.html"];
    // The title counts the mousedown events of the document and shows the selected text after each mouseup.
    [@"<!doctype html><title>press</title><style>body{margin:0}p{margin:0;font:20px monospace;position:absolute;left:0;top:0}</style>"
        "<p>abcdefghijklmnopqrstuvwxyz</p>"
        "<script>let downs = 0; addEventListener('mousedown', () => { downs += 1; });"
        "addEventListener('mouseup', () => { document.title = `downs:${downs} selected:${getSelection().toString()}`; });</script>"
        writeToFile:page atomically:YES encoding:NSUTF8StringEncoding error:nil];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    [window orderBack:nil];
    void *surface = sp_surface_create(main);
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);
    NSString *store = [temporary stringByAppendingPathComponent:@"store"];
    void *document = sp_document_create(surface, store.fileSystemRepresentation, NULL, NULL, changed, NULL);
    sp_document_place(document, 0, 0, 0, 0, true);
    check(sp_document_load(document, [NSURL fileURLWithPath:page].absoluteString.UTF8String), @"the region loads the page");
    check(until(^BOOL{ return [latest[@"title"] isEqual:@"press"] && [latest[@"loading"] isEqual:@NO]; }), @"the page loads");

    // The main webview holds the keyboard focus, as the page of the surface does before a press in the region.
    [window makeFirstResponder:main];
    check(window.firstResponder == main, @"the main webview holds the keyboard focus");
    check(!NSApp.isActive, @"the application is inactive");
    check(sp_input_pointer(window, 200, 10, 1, 0, 0, 0) == SP_INPUT_DELIVERED
        && sp_input_pointer(window, 120, 10, 2, 0, 0, 0) == SP_INPUT_DELIVERED
        && sp_input_pointer(window, 40, 10, 2, 0, 0, 0) == SP_INPUT_DELIVERED
        && sp_input_pointer(window, 40, 10, 3, 0, 0, 0) == SP_INPUT_DELIVERED, @"a native press, drag and release are delivered");
    BOOL selected = until(^BOOL{ return [latest[@"title"] hasPrefix:@"downs:1 selected:"]
        && [latest[@"title"] length] > [@"downs:1 selected:" length]; });
    check(selected, [NSString stringWithFormat:@"the first press reaches the page and the drag selects text: %@", latest[@"title"]]);

    sp_document_close(document);
    sp_surface_close(surface);
    [window close];
    [[NSFileManager defaultManager] removeItemAtPath:temporary error:nil];
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
}}
