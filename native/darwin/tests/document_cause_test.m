// Checks that every document region creation that fails reports its native cause through sp_document_last_error, so the host
// error names the cause. A data store directory that cannot be created names the directory and the error of the file system;
// each invalid argument and a surface without a native plane name the condition that failed.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "document_view.h"
#import "webview_geometry.h"
#import "window_facts.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void changed(void *context, const char *text) {
    (void)context;
    (void)text;
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 100, 100)
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        [window setReleasedWhenClosed:NO];
        WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
        [window.contentView addSubview:main];
        void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
        check(surface != NULL, @"a logical surface is created for the document");
        void *document = sp_document_create(surface, "/dev/null/soksak-store", "/tmp", "probe", NULL, "", changed, NULL);
        check(document == NULL, @"a data store under a file is not created");
        NSString *cause = [NSString stringWithUTF8String:sp_document_last_error()];
        check([cause hasPrefix:@"cannot create the data store directory /dev/null/soksak-store: "],
            [NSString stringWithFormat:@"the failure names the directory and its error: %@", cause]);

        NSString *store = [NSTemporaryDirectory() stringByAppendingPathComponent:@"soksak-document-cause-store"];
        NSView *outside = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 10, 10)] autorelease];
        NSView *plain = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 10, 10)] autorelease];
        [window.contentView addSubview:plain];
        struct { void *surface; const char *directory; const char *folder; const char *plugin; const char *channel;
            sp_document_changed changed; NSString *cause; } cases[] = {
            { NULL, store.UTF8String, "/tmp", "probe", "", changed, @"the surface is missing" },
            { outside, store.UTF8String, "/tmp", "probe", "", changed, @"the surface is not in a window" },
            { surface, NULL, "/tmp", "probe", "", changed, @"the data store directory is missing" },
            { surface, store.UTF8String, "/tmp", "probe", "", NULL, @"the change callback is missing" },
            { surface, store.UTF8String, NULL, "probe", "", changed, @"the view has no folder" },
            { surface, store.UTF8String, "/tmp", NULL, "", changed, @"the view has no plugin" },
            { surface, store.UTF8String, "/tmp", "probe", "\xff", changed, @"the channel of the view is not UTF-8" },
            { plain, store.UTF8String, "/tmp", "probe", "", changed, @"the surface has no native plane" },
            { plain, store.UTF8String, NULL, NULL, NULL, changed, @"the surface has no native plane" },
        };
        for (size_t index = 0; index < sizeof cases / sizeof cases[0]; index++) {
            void *refused = sp_document_create(cases[index].surface, cases[index].directory, cases[index].folder,
                cases[index].plugin, NULL, cases[index].channel, cases[index].changed, NULL);
            NSString *reported = [NSString stringWithUTF8String:sp_document_last_error()];
            check(refused == NULL && [reported isEqualToString:cases[index].cause],
                [NSString stringWithFormat:@"case %zu fails with \"%@\" (actual %@, \"%@\")", index, cases[index].cause,
                    refused ? @"a document" : @"no document", reported]);
        }
    }
    return failures == 0 ? 0 : 1;
}
