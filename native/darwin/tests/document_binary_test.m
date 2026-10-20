// Checks the binary store of a document region (docs/spec/native-surfaces.md#document-regions): a plugin page uploads bytes
// by POST to sok://<plugin>/.binary and downloads them by GET to sok://<plugin>/.binary/<id>, the host refuses an upload
// over 16 MiB, a page over 64 MiB, an upload for another plugin's origin and an id that is not stored, a download releases
// its id, a native take returns the bytes and releases the id, and closing the region releases every id it holds.
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
    [messages addObject:value[@"message"] ?: value];
}

static void writeFile(NSString *root, NSString *path, NSString *text) {
    NSString *file = [root stringByAppendingPathComponent:path];
    [[NSFileManager defaultManager] createDirectoryAtPath:file.stringByDeletingLastPathComponent
        withIntermediateDirectories:YES attributes:nil error:nil];
    [text writeToFile:file atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

// The reply of the page to one command. The page receives its own command first, because the message script forwards
// the messages that the window receives, and then posts exactly one reply.
static NSDictionary *ask(void *document, NSDictionary *command) {
    NSUInteger index = messages.count;
    NSData *json = [NSJSONSerialization dataWithJSONObject:command options:0 error:nil];
    NSString *text = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    check(sp_document_post(document, text.UTF8String), [NSString stringWithFormat:@"the page receives the command %@", text]);
    until([NSString stringWithFormat:@"the page answers %@", text], ^BOOL{ return messages.count >= index + 2; });
    return messages[index + 1];
}

static BOOL isBinaryId(id value) {
    if (![value isKindOfClass:NSString.class]) return NO;
    NSString *text = value;
    if (text.length != 32) return NO;
    for (NSUInteger index = 0; index < text.length; index++) {
        unichar character = [text characterAtIndex:index];
        if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return NO;
    }
    return YES;
}

static BOOL storeClosed;
static NSString *storeError;

static void recordStoreClosed(void *context, const char *error) {
    (void)context;
    storeClosed = YES;
    if (error) storeError = [@(error) retain];
}

// The bytes of a take hold the pattern that the page uploads: the byte at index i is i modulo 256.
static BOOL matchesPattern(const unsigned char *bytes, size_t length) {
    for (size_t i = 0; i < length; i++) if (bytes[i] != (unsigned char)(i & 255)) return NO;
    return YES;
}

static const size_t kMiB = 1024 * 1024;

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    messages = [NSMutableArray new];

    NSString *temporary = temporaryFolder(@"soksak-document-binary-");
    NSString *folder = [temporary stringByAppendingPathComponent:@"plugin"];
    // The page answers each command with one message. A fetch that the host refuses without a response of its own, or
    // that a cross-origin page cannot read, is answered as refused.
    writeFile(folder, @"ui/binary/index.html", @"<!doctype html><title>loading</title><script type=module src=./main.js></script>");
    writeFile(folder, @"ui/binary/main.js", @"document.title = `ready ${location.origin}`;"
        "const pattern = (size) => { const bytes = new Uint8Array(size); for (let i = 0; i < size; i++) bytes[i] = i & 255; return bytes; };"
        "const matches = (bytes) => { for (let i = 0; i < bytes.length; i++) if (bytes[i] !== (i & 255)) return false; return true; };"
        "const upload = async (size) => {"
        "const response = await fetch('sok://probe/.binary', { method: 'POST', body: pattern(size), headers: { 'Content-Type': 'application/x-test' } });"
        "return { status: response.status, body: await response.json() }; };"
        "const download = async (id) => {"
        "const response = await fetch(`sok://probe/.binary/${id}`);"
        "const bytes = new Uint8Array(await response.arrayBuffer());"
        "return { status: response.status, type: response.headers.get('Content-Type'), length: response.headers.get('Content-Length'), size: bytes.length, equal: matches(bytes) }; };"
        "addEventListener('message', async (event) => {"
        "if (event.source !== window || !event.data || !event.data.run) return;"
        "const command = event.data;"
        "let result;"
        "try {"
        "if (command.run === 'upload') result = await upload(command.size);"
        "else if (command.run === 'download') result = await download(command.id);"
        "else if (command.run === 'upload-other') {"
        "try { const response = await fetch('sok://other/.binary', { method: 'POST', body: pattern(1) }); result = { refused: false, status: response.status }; }"
        "catch (error) { result = { refused: true }; }"
        "} else result = { error: 'unknown command ' + command.run };"
        "} catch (error) { result = { error: String(error) }; }"
        "postMessage(result, location.origin); });");

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
        check(sp_document_load(document, "sok://probe/ui/binary/index.html"), @"a region loads the binary page");
        until(@"the binary page runs", ^BOOL{ return [latest[@"title"] hasPrefix:@"ready"]; });

        // A 1 MiB upload returns its id and length, and the download returns the same bytes once.
        NSDictionary *uploaded = ask(document, @{ @"run": @"upload", @"size": @(kMiB) });
        check([uploaded[@"status"] isEqual:@200], [NSString stringWithFormat:@"a 1 MiB upload is stored: %@", uploaded]);
        check([uploaded[@"body"][@"length"] isEqual:@(kMiB)], [NSString stringWithFormat:@"the upload reports its length: %@", uploaded]);
        NSString *first = uploaded[@"body"][@"id"];
        check(isBinaryId(first), [NSString stringWithFormat:@"the upload answers a 32-character lowercase hex id: %@", first]);

        NSDictionary *downloaded = ask(document, @{ @"run": @"download", @"id": first ?: @"" });
        check([downloaded[@"status"] isEqual:@200] && [downloaded[@"equal"] isEqual:@YES] && [downloaded[@"size"] isEqual:@(kMiB)],
            [NSString stringWithFormat:@"a 1 MiB download returns the uploaded bytes: %@", downloaded]);
        check([downloaded[@"type"] isEqual:@"application/x-test"] && [downloaded[@"length"] isEqual:[@(kMiB) stringValue]],
            [NSString stringWithFormat:@"the download keeps the content type and the content length: %@", downloaded]);

        NSDictionary *again = ask(document, @{ @"run": @"download", @"id": first ?: @"" });
        check([again[@"status"] isEqual:@404], [NSString stringWithFormat:@"a second download of the same id is not found: %@", again]);

        // A native take returns the bytes of an id and releases it; the second take fails.
        NSDictionary *second = ask(document, @{ @"run": @"upload", @"size": @(kMiB) });
        NSString *taken = second[@"body"][@"id"];
        check(isBinaryId(taken), [NSString stringWithFormat:@"a second upload is stored: %@", second]);
        check(sp_document_binary_count(document) == 1, [NSString stringWithFormat:@"the region holds one id: %zu", sp_document_binary_count(document)]);
        void *bytes = NULL;
        size_t length = 0;
        const char *error = sp_document_binary_take(document, taken.UTF8String, &bytes, &length);
        check(error == NULL, [NSString stringWithFormat:@"a native take of a stored id returns its bytes: %s", error ?: "ok"]);
        check(length == kMiB && bytes != NULL && matchesPattern(bytes, length),
            [NSString stringWithFormat:@"the taken bytes are the uploaded 1 MiB: %zu", length]);
        free(bytes);
        const char *again_take = sp_document_binary_take(document, taken.UTF8String, &bytes, &length);
        check(again_take != NULL, @"a native take releases the id, so a second take of it fails");
        check(sp_document_binary_count(document) == 0, [NSString stringWithFormat:@"the take leaves no id: %zu", sp_document_binary_count(document)]);

        // An upload over 16 MiB is refused with 413 and stores nothing.
        NSDictionary *big = ask(document, @{ @"run": @"upload", @"size": @(17 * kMiB) });
        check([big[@"status"] isEqual:@413], [NSString stringWithFormat:@"a 17 MiB upload is refused with 413: %@", big]);
        check(sp_document_binary_count(document) == 0, @"a refused upload stores nothing");

        // An upload for another plugin's origin is refused, and it stores nothing.
        NSDictionary *other = ask(document, @{ @"run": @"upload-other" });
        check([other[@"refused"] isEqual:@YES], [NSString stringWithFormat:@"an upload to another plugin's origin is refused: %@", other]);
        check(sp_document_binary_count(document) == 0, @"a refused upload to another origin stores nothing");

        // Four 16 MiB uploads fill the page limit of 64 MiB; a fifth byte is refused with 413.
        for (int index = 0; index < 4; index++) {
            NSDictionary *full = ask(document, @{ @"run": @"upload", @"size": @(16 * kMiB) });
            check([full[@"status"] isEqual:@200], [NSString stringWithFormat:@"16 MiB upload %d of the page is stored: %@", index + 1, full]);
        }
        NSDictionary *over = ask(document, @{ @"run": @"upload", @"size": @1 });
        check([over[@"status"] isEqual:@413], [NSString stringWithFormat:@"an upload over the page limit of 64 MiB is refused with 413: %@", over]);
        check(sp_document_binary_count(document) == 4, [NSString stringWithFormat:@"the region holds the four uploads: %zu", sp_document_binary_count(document)]);

        // Closing the region releases every id it holds. The count reads the region after it closes, so the test keeps
        // the region alive until the count is read.
        id region = (id)document;
        [region retain];
        sp_document_close(document);
        check(sp_document_binary_count((void *)region) == 0,
            [NSString stringWithFormat:@"closing the region releases its ids: %zu", sp_document_binary_count((void *)region)]);
        [region release];
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
