// Checks the package documents of document regions (docs/spec/native-surfaces.md#document-regions): a region loads a
// file of its plugin's package at a soksak-package address with the content type of its extension, refuses another
// plugin's address and a path that leaves the package, and exchanges JSON messages with its page.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "document_view.h"
#import "webview_geometry.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void until(NSString *what, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    if (!done()) { fprintf(stderr, "FAIL: %s within 10 seconds\n", what.UTF8String); exit(1); }
}

static NSDictionary *latest;
static NSMutableArray<id> *messages;

static void changed(void *context, const char *text) {
    (void)context;
    latest = [[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:text length:strlen(text)] options:0 error:nil] retain];
}

static void message(void *context, const char *text) {
    (void)context;
    NSDictionary *value = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:text length:strlen(text)] options:0 error:nil];
    [messages addObject:value[@"message"] ?: @{ @"error": value[@"error"] }];
}

static void writeFile(NSString *root, NSString *path, NSString *text) {
    NSString *file = [root stringByAppendingPathComponent:path];
    [[NSFileManager defaultManager] createDirectoryAtPath:file.stringByDeletingLastPathComponent
        withIntermediateDirectories:YES attributes:nil error:nil];
    [text writeToFile:file atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    messages = [NSMutableArray new];

    NSString *temporary = [NSTemporaryDirectory() stringByAppendingPathComponent:
        [NSString stringWithFormat:@"soksak-document-package-%d", getpid()]];
    NSString *package = [temporary stringByAppendingPathComponent:@"package"];
    NSString *outside = [temporary stringByAppendingPathComponent:@"secret.html"];
    // The page module answers each {ping} message with {pong}; it loads as a module, so it needs text/javascript.
    writeFile(package, @"ui/app/index.html", @"<!doctype html><title>loading</title><script type=module src=./main.js></script>");
    writeFile(package, @"ui/app/main.js", @"document.title = `ready ${location.origin}`;"
        "addEventListener('message', (event) => { if (event.data && event.data.ping) postMessage({ pong: event.data.ping }, location.origin); });");
    writeFile(temporary, @"secret.html", @"<!doctype html><title>outside</title>");
    (void)outside;

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
    void *document = sp_document_create(surface, store.fileSystemRepresentation, package.fileSystemRepresentation, "probe", changed, NULL);
    check(document != NULL, @"a document region is created with the package of its plugin");
    sp_document_set_message(document, message, NULL);
    sp_document_place(document, 0, 0, 0, 0, true);

    check(!sp_document_post(document, "{\"ping\":1}"), @"a document that is not a package document has no message channel");
    check(sp_document_load(document, "soksak-package://probe/ui/app/index.html"), @"a region loads a soksak-package address");
    until(@"the package page module runs", ^BOOL{ return [latest[@"title"] hasPrefix:@"ready"]; });
    check([latest[@"title"] isEqual:@"ready soksak-package://probe"],
        [NSString stringWithFormat:@"the package document has the origin of its plugin: %@", latest[@"title"]]);

    check(sp_document_post(document, "{\"ping\":7}"), @"the page posts a message to a package document");
    until(@"the package document answers", ^BOOL{ return messages.count >= 2; });
    check([messages[0] isEqual:@{ @"ping": @7 }], [NSString stringWithFormat:@"the page receives its own message first: %@", messages]);
    check([messages[1] isEqual:@{ @"pong": @7 }], [NSString stringWithFormat:@"the page receives the answer: %@", messages]);

    // The URL parser resolves the dot segments, so the last address requests soksak-package://probe/secret.html.
    NSDictionary<NSString *, NSString *> *refused = @{
        @"soksak-package://other/ui/app/index.html": @"soksak-package://other/ui/app/index.html is not found",
        @"soksak-package://probe/ui/app/missing.html": @"soksak-package://probe/ui/app/missing.html is not found",
        @"soksak-package://probe/ui/../../secret.html": @"soksak-package://probe/secret.html is not found",
    };
    for (NSString *address in refused) {
        check(sp_document_load(document, address.UTF8String), [NSString stringWithFormat:@"%@ starts a load", address]);
        // A failed load keeps the previous document, so the load is settled when the region reports its error.
        until([NSString stringWithFormat:@"%@ fails", address], ^BOOL{
            return [latest[@"loading"] isEqual:@NO] && [latest[@"error"] isKindOfClass:NSString.class] && [latest[@"error"] containsString:refused[address]];
        });
        check(![latest[@"title"] isEqual:@"outside"], [NSString stringWithFormat:@"%@ is not found: %@", address, latest[@"error"]]);
    }

    sp_document_close(document);
    sp_surface_close(surface);
    [window close];
    [[NSFileManager defaultManager] removeItemAtPath:temporary error:nil];
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
}}
