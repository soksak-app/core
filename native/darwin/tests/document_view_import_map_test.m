// Checks the view import map insertion (docs/spec/plugin-processes.md, rule 4). The cases of the published fixture
// (VIEW_PAGE_CASES, packages/plugin-api/contract/view-page.json) run through sp_view_page_insert, and a view loads a page
// of its plugin that holds no import map, so the page of the view holds the map of the application.
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

static void writeFile(NSString *root, NSString *path, NSString *text) {
    NSString *file = [root stringByAppendingPathComponent:path];
    [[NSFileManager defaultManager] createDirectoryAtPath:file.stringByDeletingLastPathComponent
        withIntermediateDirectories:YES attributes:nil error:nil];
    [text writeToFile:file atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

// Runs one case of the fixture: a page after the insertion, or the reason of its refusal.
static void checkCase(NSDictionary *testCase, NSString *fixtureMap) {
    NSString *name = testCase[@"name"];
    NSString *map = testCase[@"map"] ?: fixtureMap;
    char *output = NULL;
    char *error = NULL;
    bool inserted = sp_view_page_insert(((NSString *)testCase[@"input"]).UTF8String, map.UTF8String, &output, &error);
    if (testCase[@"error"]) {
        NSString *reason = error ? [NSString stringWithUTF8String:error] : @"none";
        check(!inserted && [reason isEqualToString:testCase[@"error"]],
            [NSString stringWithFormat:@"view page insertion %@: refused with %@, want %@", name, reason, testCase[@"error"]]);
    } else {
        NSString *page = output ? [NSString stringWithUTF8String:output] : @"none";
        check(inserted && [page isEqualToString:testCase[@"output"]],
            [NSString stringWithFormat:@"view page insertion %@: page is %@", name, page]);
    }
    free(output);
    free(error);
}

// The page writes the number of import map elements of its document when its script runs. A page of the view that holds the
// map of the application counts one.
static NSString *const plainPage = @"<!doctype html><meta charset=utf-8><title>loading</title>"
    "<script>document.title = 'loaded ' + document.querySelectorAll('script[type=importmap]').length;</script>";

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSData *fixtureData = [NSData dataWithContentsOfFile:[NSString stringWithUTF8String:VIEW_PAGE_CASES]];
    NSDictionary *fixture = fixtureData ? [NSJSONSerialization JSONObjectWithData:fixtureData options:0 error:nil] : nil;
    if (!fixture) { fprintf(stderr, "FAIL: the view page cases cannot be read from %s\n", VIEW_PAGE_CASES); return 1; }
    NSString *fixtureMap = fixture[@"map"];
    for (NSDictionary *testCase in fixture[@"cases"]) checkCase(testCase, fixtureMap);

    sp_view_import_map_set(fixtureMap.UTF8String);
    NSString *temporary = temporaryFolder(@"soksak-document-view-map-");
    NSString *folder = [temporary stringByAppendingPathComponent:@"plugin"];
    writeFile(folder, @"ui/page.html", plainPage);

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

    @autoreleasepool {
        void *view = sp_document_create(surface, store.fileSystemRepresentation, folder.fileSystemRepresentation, "probe", "", changed, NULL);
        check(view != NULL, @"a view configuration is created with the folder and the plugin of its surface");
        sp_document_place(view, 0, 0, 0, 0, true);
        latest = nil;
        check(sp_document_load(view, "sok://probe/ui/page.html"), @"the view loads the page of its plugin");
        until(@"the view page runs its script", ^BOOL{ return [latest[@"title"] hasPrefix:@"loaded"]; });
        check([latest[@"title"] isEqual:@"loaded 1"],
            [NSString stringWithFormat:@"the view page holds the import map of the application once: %@", latest[@"title"]]);
        sp_document_close(view);
    }
    sp_surface_close(surface);
    [window close];
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
}}
