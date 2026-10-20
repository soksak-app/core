// Checks the plugin documents of document regions (docs/spec/native-surfaces.md#document-regions): a region loads a
// file of its plugin at a sok address with the content type of its extension, refuses another owner's address and a
// path that leaves the plugin folder, and exchanges JSON messages with its page.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "support/temporary_folder.h"
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

static BOOL storeClosed;
static NSString *storeError;

static void recordStoreClosed(void *context, const char *error) {
    storeClosed = YES;
    if (error) storeError = [@(error) retain];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    messages = [NSMutableArray new];

    NSString *temporary = temporaryFolder(@"soksak-document-plugin-");
    NSString *folder = [temporary stringByAppendingPathComponent:@"plugin"];
    NSString *outside = [temporary stringByAppendingPathComponent:@"secret.html"];
    // The page module answers each {ping} message with {pong}, and each {reply} message with the value that the name
    // selects; it loads as a module, so it needs text/javascript.
    writeFile(folder, @"ui/app/index.html", @"<!doctype html><title>loading</title><script type=module src=./main.js></script>");
    writeFile(folder, @"ui/app/main.js", @"document.title = `ready ${location.origin}`;"
        "const replies = {"
        "buffer: () => new ArrayBuffer(4), bytes: () => new Uint8Array([1, 2]), date: () => new Date(0),"
        "nested: () => ({ list: [1, 'a', null, true], text: 'ok' }),"
        "cycle: () => { const value = {}; value.self = value; return value; } };"
        "addEventListener('message', (event) => {"
        "if (event.data && event.data.ping) postMessage({ pong: event.data.ping }, location.origin);"
        "if (event.data && event.data.reply) postMessage(replies[event.data.reply](), location.origin); });");
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
    // The document and every autoreleased reference to it live in this pool, so the closed document and its data store are
    // released before the store ends.
    @autoreleasepool {
        void *document = sp_document_create(surface, store.fileSystemRepresentation, folder.fileSystemRepresentation, "probe", changed, NULL);
        check(document != NULL, @"a document region is created with the folder of its plugin");
        sp_document_set_message(document, message, NULL);
        sp_document_place(document, 0, 0, 0, 0, true);

        check(!sp_document_post(document, "{\"ping\":1}"), @"a document that is not a plugin document has no message channel");
        check(sp_document_load(document, "sok://probe/ui/app/index.html"), @"a region loads a sok address");
        until(@"the plugin page module runs", ^BOOL{ return [latest[@"title"] hasPrefix:@"ready"]; });
        check([latest[@"title"] isEqual:@"ready sok://probe"],
            [NSString stringWithFormat:@"the plugin document has the origin of its plugin: %@", latest[@"title"]]);

        check(sp_document_post(document, "{\"ping\":7}"), @"the page posts a message to a plugin document");
        until(@"the plugin document answers", ^BOOL{ return messages.count >= 2; });
        check([messages[0] isEqual:@{ @"ping": @7 }], [NSString stringWithFormat:@"the page receives its own message first: %@", messages]);
        check([messages[1] isEqual:@{ @"pong": @7 }], [NSString stringWithFormat:@"the page receives the answer: %@", messages]);

        // A page message that JSON cannot hold is refused with the type of the value; a plain object arrives unchanged.
        NSArray<NSArray *> *replies = @[
            @[ @"buffer", @{ @"error": @"the message holds an ArrayBuffer, which is not JSON" } ],
            @[ @"bytes", @{ @"error": @"the message holds a Uint8Array, which is not JSON" } ],
            @[ @"date", @{ @"error": @"the message holds a Date, which is not JSON" } ],
            @[ @"cycle", @{ @"error": @"the message holds a cycle, which is not JSON" } ],
            @[ @"nested", @{ @"list": @[ @1, @"a", NSNull.null, @YES ], @"text": @"ok" } ],
        ];
        for (NSArray *reply in replies) {
            NSUInteger index = messages.count;
            check(sp_document_post(document, [NSString stringWithFormat:@"{\"reply\":\"%@\"}", reply[0]].UTF8String),
                [NSString stringWithFormat:@"the plugin document posts the %@ reply request", reply[0]]);
            // The page receives its own request first, then the answer.
            until([NSString stringWithFormat:@"the page answers the %@ reply", reply[0]], ^BOOL{ return messages.count >= index + 2; });
            check([messages[index] isEqual:@{ @"reply": reply[0] }],
                [NSString stringWithFormat:@"the page receives its %@ request first: %@", reply[0], messages[index]]);
            check([messages[index + 1] isEqual:reply[1]],
                [NSString stringWithFormat:@"the %@ reply arrives as %@: %@", reply[0], reply[1], messages[index + 1]]);
        }

        // The URL parser resolves the dot segments, so the last address requests sok://probe/secret.html.
        NSDictionary<NSString *, NSString *> *refused = @{
            @"sok://other/ui/app/index.html": @"sok://other/ui/app/index.html is not found",
            @"sok://probe/ui/app/missing.html": @"sok://probe/ui/app/missing.html is not found",
            @"sok://probe/ui/../../secret.html": @"sok://probe/secret.html is not found",
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
    }
    // The store ends before the check removes its folder, so the network process writes nothing into it afterward.
    sp_document_store_close(store.fileSystemRepresentation, recordStoreClosed, NULL);
    until(@"the data store ends", ^BOOL{ return storeClosed; });
    check(storeError == nil, [NSString stringWithFormat:@"the data store ends without an error: %@", storeError]);
    sp_surface_close(surface);
    [window close];
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
}}
