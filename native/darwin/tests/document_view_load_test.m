// Checks that a view configuration (docs/spec/native-surfaces.md#view-surfaces) loads the page of its plugin: the host creates the view
// with isView set and the folder and the plugin of the surface, then loads sok://<plugin>/<page>, and the page runs its script.
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

// The page writes its title when its script runs, so the title shows that the page of the view loaded.
static NSString *const viewPage = @"<!doctype html><meta charset=utf-8><title>loading</title>"
    "<script>document.title = 'loaded ' + location.origin;</script>";

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSString *temporary = temporaryFolder(@"soksak-document-view-load-");
    NSString *folder = [temporary stringByAppendingPathComponent:@"plugin"];
    writeFile(folder, @"ui/page.html", viewPage);

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
        void *view = sp_document_create(surface, store.fileSystemRepresentation, folder.fileSystemRepresentation, "probe", true, changed, NULL);
        check(view != NULL, @"a view configuration is created with the folder and the plugin of its surface");
        sp_document_place(view, 0, 0, 0, 0, true);
        latest = nil;
        check(sp_document_load(view, "sok://probe/ui/page.html"), @"the view loads the page of its plugin");
        until(@"the view page runs its script", ^BOOL{ return [latest[@"title"] hasPrefix:@"loaded"]; });
        check([latest[@"title"] isEqual:@"loaded sok://probe"],
            [NSString stringWithFormat:@"the page of the view runs with the origin of its plugin: %@", latest[@"title"]]);
        check([latest[@"error"] isEqual:NSNull.null], @"loading the view page reports no error");
        sp_document_close(view);
    }
    sp_surface_close(surface);
    [window close];
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
}}
