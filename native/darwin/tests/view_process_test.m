// Checks the WebContent processes of views (docs/spec/plugin-processes.md#view-processes): views of one plugin and data store that
// share a process run in one WebContent process, a view that does not share starts its own, a view of another plugin does not join
// it, a sharing view joins the remaining sharing view after the first one closes, a sharing view of a plugin whose views do not
// share joins the process of an open view, and a document region refuses to share.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "support/temporary_folder.h"
#import "support/view_import_map.h"
#import "support/event_wait.h"
#import "document_view.h"
#import "private/webkit.h"
#import "webview_geometry.h"
#import "window_facts.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

enum { kViews = 8 };
static NSDictionary *states[kViews];

// Keeps the last state of the view whose index is the context.
static void changed(void *context, const char *text) {
    intptr_t index = (intptr_t)context;
    [states[index] release];
    states[index] = [[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:text length:strlen(text)] options:0 error:nil] retain];
}

static void writeFile(NSString *root, NSString *path, NSString *text) {
    NSString *file = [root stringByAppendingPathComponent:path];
    [[NSFileManager defaultManager] createDirectoryAtPath:file.stringByDeletingLastPathComponent
        withIntermediateDirectories:YES attributes:nil error:nil];
    [text writeToFile:file atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

static NSString *const page = @"<!doctype html><meta charset=utf-8><title>view</title><body>view</body>";

// Creates the view of plugin with index as its state slot, loads its page and returns it after the load ends, or NULL.
static void *openView(void *surface, NSString *store, NSString *root, const char *plugin, bool sharesProcess, intptr_t index) {
    NSString *folder = [root stringByAppendingPathComponent:@(plugin)];
    void *view = sp_document_create(surface, store.fileSystemRepresentation, folder.fileSystemRepresentation, plugin,
        [@"soksak://plugin/" stringByAppendingString:@(plugin)].UTF8String, "window.sokView = 1;", sharesProcess, changed,
        (void *)index);
    check(view != NULL, [NSString stringWithFormat:@"view %ld of %s is created: %s", (long)index, plugin, sp_document_last_error()]);
    if (!view) return NULL;
    sp_document_place(view, 0, 0, 0, 0, true);
    NSString *url = [NSString stringWithFormat:@"soksak://%s/page.html", plugin];
    check(sp_document_load(view, url.UTF8String), [NSString stringWithFormat:@"view %ld loads %@", (long)index, url]);
    eventWait([NSString stringWithFormat:@"view %ld ends its load", (long)index], ^BOOL {
        return [states[index][@"url"] isEqual:url] && ![states[index][@"loading"] boolValue];
    });
    return view;
}

static pid_t processOf(void *view) {
    return view ? ((WKWebView *)view)._webProcessIdentifier : 0;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSString *temporary = temporaryFolder(@"soksak-view-process-");
    sp_view_import_map_set(viewImportMapFixture().UTF8String);
    writeFile(temporary, @"probe/page.html", page);
    writeFile(temporary, @"other/page.html", page);
    writeFile(temporary, @"solo/page.html", page);
    NSString *store = [temporary stringByAppendingPathComponent:@"store"];

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

    void *first = openView(surface, store, temporary, "probe", true, 0);
    void *second = openView(surface, store, temporary, "probe", true, 1);
    void *separate = openView(surface, store, temporary, "probe", false, 2);
    void *other = openView(surface, store, temporary, "other", true, 3);
    pid_t firstProcess = processOf(first), secondProcess = processOf(second);
    pid_t separateProcess = processOf(separate), otherProcess = processOf(other);
    printf("PROCESSES first=%d second=%d separate=%d other=%d\n", firstProcess, secondProcess, separateProcess, otherProcess);
    check(firstProcess > 0 && secondProcess == firstProcess, @"two sharing views of one plugin run in one WebContent process");
    check(separateProcess > 0 && separateProcess != firstProcess, @"a view that does not share starts its own WebContent process");
    check(otherProcess > 0 && otherProcess != firstProcess, @"a sharing view of another plugin does not join the process");

    if (first) sp_document_close(first);
    void *later = openView(surface, store, temporary, "probe", true, 4);
    pid_t laterProcess = processOf(later);
    printf("PROCESSES later=%d second=%d\n", laterProcess, secondProcess);
    check(laterProcess > 0 && laterProcess == secondProcess,
        @"a sharing view joins the remaining sharing view after the first one closes");

    // A view opened without sharing, then a sharing view of the same plugin: the second joins the process of the first, as a view
    // opened after the setting changes joins the views already open.
    void *alone = openView(surface, store, temporary, "solo", false, 6);
    void *joining = openView(surface, store, temporary, "solo", true, 7);
    printf("PROCESSES alone=%d joining=%d\n", processOf(alone), processOf(joining));
    check(processOf(alone) > 0 && processOf(joining) == processOf(alone),
        @"a sharing view joins the process of an open view of its plugin that does not share");

    void *region = sp_document_create(surface, store.fileSystemRepresentation,
        [temporary stringByAppendingPathComponent:@"probe"].fileSystemRepresentation, "probe", NULL, NULL, true, changed, (void *)5);
    check(region == NULL, @"a document region refuses to share a process");
    check(strcmp(sp_document_last_error(), "a document region does not share a process") == 0,
        [NSString stringWithFormat:@"the refusal states its cause: %s", sp_document_last_error()]);
    if (region) sp_document_close(region);

    void *views[] = {second, separate, other, later, alone, joining};
    for (size_t index = 0; index < sizeof(views) / sizeof(views[0]); index++) {
        if (views[index]) sp_document_close(views[index]);
    }
    sp_surface_close(surface);
    [window close];
    [window release];
    if (failures) {
        fprintf(stderr, "FAIL: view_process_test: %d failed checks\n", failures);
        return 1;
    }
    printf("PASS: view_process_test\n");
    return 0;
}}
