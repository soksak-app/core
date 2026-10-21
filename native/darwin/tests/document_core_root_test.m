// Checks the core root of a view (docs/spec/plugin-processes.md, rule 4): a view configuration requests sok://core/<path>
// from the core root resolver of the application and imports the files that the resolver serves, each with the header
// Access-Control-Allow-Origin of its plugin; a refused path fails with no such header; and a document region receives no
// core root grant, so its requests to sok://core fail without calling the resolver.
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

static void changed(void *context, const char *text) {
    (void)context;
    latest = [[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:text length:strlen(text)] options:0 error:nil] retain];
}

// The calls of the resolver of the application, each written as "<plugin> <path>". Only the file of probe is served.
static NSMutableArray<NSString *> *resolverCalls;

static bool resolveCoreRoot(void *context, const char *plugin, const char *path, void **bytes, size_t *length, char **type) {
    (void)context;
    [resolverCalls addObject:[NSString stringWithFormat:@"%s %s", plugin, path]];
    if (strcmp(plugin, "probe") != 0 || strcmp(path, "/modules/probe/m.js") != 0) return false;
    const char *text = "export default 42;\n";
    *length = strlen(text);
    *bytes = malloc(*length);
    memcpy(*bytes, text, *length);
    *type = strdup("text/javascript");
    return true;
}

static void writeFile(NSString *root, NSString *path, NSString *text) {
    NSString *file = [root stringByAppendingPathComponent:path];
    [[NSFileManager defaultManager] createDirectoryAtPath:file.stringByDeletingLastPathComponent
        withIntermediateDirectories:YES attributes:nil error:nil];
    [text writeToFile:file atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

// The page imports a file of its own core root and fetches the same file. Each result is written to the title as JSON:
// granted is the module value or fail, refused is imported or fail, served is the HTTP status of a fetch that the page
// reads with CORS, and refusedFetch is the status of a refused fetch or fail. A response without
// Access-Control-Allow-Origin makes the fetch reject, so refusedFetch is fail when the refusal carries no such header.
static NSString *const probePage = @"<!doctype html><meta charset=utf-8><title>loading</title>"
    "<script type=module>"
    "const steps = {};"
    "steps.granted = await import('sok://core/modules/probe/m.js').then((m) => String(m.default), () => 'fail');"
    "steps.refused = await import('sok://core/modules/other/secret.js').then(() => 'imported', () => 'fail');"
    "steps.served = await fetch('sok://core/modules/probe/m.js').then((r) => String(r.status), () => 'fail');"
    "steps.refusedFetch = await fetch('sok://core/modules/other/secret.js').then((r) => String(r.status), () => 'fail');"
    "document.title = JSON.stringify(steps);"
    "</script>";

// Loads the probe page in a document of the given kind and returns its steps once the page has written them.
static NSDictionary *runPage(void *document) {
    latest = nil;
    check(sp_document_load(document, "sok://probe/ui/core/probe.html"), @"the probe page starts a load");
    until(@"the probe page writes its steps", ^BOOL{ return [latest[@"title"] hasPrefix:@"{"]; });
    return [NSJSONSerialization JSONObjectWithData:[latest[@"title"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSString *temporary = temporaryFolder(@"soksak-document-core-root-");
    NSString *folder = [temporary stringByAppendingPathComponent:@"plugin"];
    writeFile(folder, @"ui/core/probe.html", probePage);

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
    resolverCalls = [NSMutableArray new];
    sp_core_root_set_resolver(resolveCoreRoot, NULL);

    @autoreleasepool {
        // A view without its plugin is not created, so the core root is never granted to an unnamed requester.
        check(sp_document_create(surface, store.fileSystemRepresentation, folder.fileSystemRepresentation, NULL, "", changed, NULL) == NULL,
            @"a view without a plugin is not created");

        void *view = sp_document_create(surface, store.fileSystemRepresentation, folder.fileSystemRepresentation, "probe", "", changed, NULL);
        check(view != NULL, @"a view is created with the folder and the plugin of its page");
        sp_document_place(view, 0, 0, 0, 0, true);
        NSDictionary *steps = runPage(view);
        check([steps[@"granted"] isEqual:@"42"],
            [NSString stringWithFormat:@"a view imports the granted module of its core root: %@", steps]);
        check([resolverCalls containsObject:@"probe /modules/probe/m.js"],
            [NSString stringWithFormat:@"the resolver receives the plugin of the view and the path: %@", resolverCalls]);
        check([steps[@"refused"] isEqual:@"fail"], [NSString stringWithFormat:@"a view imports a refused core path and fails: %@", steps]);
        check([resolverCalls containsObject:@"probe /modules/other/secret.js"],
            [NSString stringWithFormat:@"the resolver receives the refused path: %@", resolverCalls]);
        check([steps[@"served"] isEqual:@"200"],
            [NSString stringWithFormat:@"a served core response has the header that a fetch of the view reads: %@", steps]);
        check([steps[@"refusedFetch"] isEqual:@"fail"],
            [NSString stringWithFormat:@"a refused core response carries no Access-Control-Allow-Origin and the fetch fails: %@", steps]);
        sp_document_close(view);

        // A region gets no core root grant: its core requests fail and the resolver is not called for them.
        [resolverCalls removeAllObjects];
        void *region = sp_document_create(surface, store.fileSystemRepresentation, folder.fileSystemRepresentation, "probe", NULL, changed, NULL);
        check(region != NULL, @"a document region is created with the folder of its plugin");
        sp_document_place(region, 0, 0, 0, 0, true);
        steps = runPage(region);
        check([steps[@"granted"] isEqual:@"fail"] && [steps[@"served"] isEqual:@"fail"],
            [NSString stringWithFormat:@"a region cannot import or fetch a granted core path: %@", steps]);
        check(resolverCalls.count == 0, [NSString stringWithFormat:@"a region does not call the core root resolver: %@", resolverCalls]);
        sp_document_close(region);
    }
    sp_core_root_set_resolver(NULL, NULL);
    sp_surface_close(surface);
    [window close];
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
}}
