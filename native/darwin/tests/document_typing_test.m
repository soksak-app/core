// Checks that a document region takes typed text (docs/spec/native-surfaces.md#document-regions): a native press on a
// text field of the region document focuses it, and native keys sent to the window of an inactive application insert
// their characters into the field.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "support/temporary_folder.h"
#import "document_view.h"
#import "input_inject.h"
#import "webview_geometry.h"
#import "window_facts.h"
#import "support/event_wait.h"

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

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSString *temporary = temporaryFolder(@"soksak-document-typing-");
    NSString *page = [temporary stringByAppendingPathComponent:@"type.html"];
    // The title shows the keys of the keydown and keyup events that the document receives and the value of the field. The keyup
    // of a key comes after the input of its character, so the value is judged when the keyup of the last key arrives.
    [@"<!doctype html><title>type</title><style>body{margin:0}</style>"
        "<input id=field style='position:absolute;left:0;top:0;width:200px;height:40px'>"
        "<script>let keys = '', ups = ''; const show = () => { document.title = `keys:${keys} ups:${ups} typed:${field.value}`; };"
        "addEventListener('keydown', (event) => { keys += event.key; show(); }, true);"
        "addEventListener('keyup', (event) => { ups += event.key; show(); }, true); field.addEventListener('input', show);</script>"
        writeToFile:page atomically:YES encoding:NSUTF8StringEncoding error:nil];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    [window orderBack:nil];
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);
    NSString *store = [temporary stringByAppendingPathComponent:@"store"];
    void *document = sp_document_create(surface, store.fileSystemRepresentation, NULL, NULL, NULL, NULL, changed, NULL);
    sp_document_place(document, 0, 0, 0, 0, true);
    check(sp_document_load(document, [NSURL fileURLWithPath:page].absoluteString.UTF8String), @"the region loads the page");
    eventWait(@"the page loads", ^BOOL{ return [latest[@"title"] isEqual:@"type"] && [latest[@"loading"] isEqual:@NO]; });

    check(!NSApp.isActive && NSApp.keyWindow == nil, @"the application is inactive and has no key window");
    sp_input_result pressed = sp_input_pointer(window, 100, 20, 1, 0, 0, 0);
    sp_input_result released = pressed == SP_INPUT_DELIVERED ? sp_input_pointer(window, 100, 20, 3, 0, 0, 0) : SP_INPUT_REJECTED;
    check(pressed == SP_INPUT_DELIVERED && released == SP_INPUT_DELIVERED, [NSString stringWithFormat:
        @"a native press on the field is delivered (press %d, release %d; input_inject.h names each result)", pressed, released]);
    for (NSString *key in @[ @"x", @"y" ]) {
        check(sp_input_key(window, key.UTF8String, key.UTF8String, 0, true) == SP_INPUT_DELIVERED
            && sp_input_key(window, key.UTF8String, key.UTF8String, 0, false) == SP_INPUT_DELIVERED,
            [NSString stringWithFormat:@"the key %@ is delivered", key]);
    }
    eventWait(@"the document receives the keyup of the last key", ^BOOL{ return [latest[@"title"] containsString:@" ups:xy "]; });
    check([latest[@"title"] hasSuffix:@" typed:xy"], [NSString stringWithFormat:@"the field takes the typed text: %@", latest[@"title"]]);

    sp_document_close(document);
    sp_surface_close(surface);
    [window close];
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
}}
