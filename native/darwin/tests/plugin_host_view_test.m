// Checks the plugin host web view: the operation creates it hidden at a zero frame in the window itself, refuses an
// incomplete configuration, is counted in the window facts as a plugin host web view, and disposes it
// (docs/spec/plugin-host.md, docs/spec/native-surfaces.md).
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "document_view.h"
#import "window_facts.h"
#import "support/temporary_folder.h"
#import "support/view_import_map.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void hostChanged(void *context, const char *state) {
    (void)context; (void)state;
}

int main(int argc, char **argv) {
    (void)argc; (void)argv;
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        [NSApp finishLaunching];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        [window setReleasedWhenClosed:NO];
        window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
        WKWebView *main = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
        [window.contentView addSubview:main];
        check(sp_window_set_main_webview(window, main), @"the main page web view is registered");
        [window orderBack:nil];

        sp_view_import_map_set(viewImportMapFixture().UTF8String);
        NSString *stores = temporaryFolder(@"soksak-plugin-host-store-");
        NSString *store = [stores stringByAppendingPathComponent:@"host"];

        void *host = sp_plugin_host_create(window, store.fileSystemRepresentation, "/plugins/probe", "probe",
            "window.sokView = 1;", hostChanged, NULL);
        check(host != NULL, @"the host web view is created for a window with its configuration");
        if (host) {
            WKWebView *view = (__bridge WKWebView *)host;
            check(view.hidden, @"the host web view is hidden");
            check(CGRectIsEmpty(view.frame), @"the host web view holds a zero frame");
            check(view.superview == window.contentView, @"the host web view is attached to the window itself");
            NSPoint center = NSMakePoint(250, 200);
            NSView *hit = [window.contentView hitTest:center];
            check(hit != view && ![hit isDescendantOf:view], @"no hit test reaches the host web view");
            check(window.firstResponder != view, @"the host web view never became the first responder");
            char *json = sp_window_facts(window);
            NSDictionary *facts = json ? [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:strlen(json)]
                options:0 error:nil] : nil;
            free(json);
            NSDictionary *row = nil;
            for (NSDictionary *item in facts[@"webviews"])
                if ([item[@"view"] unsignedLongLongValue] == (uintptr_t)host) row = item;
            check([facts[@"pluginHostWebviews"] isEqual:@1] && [facts[@"appDomWebviews"] isEqual:@1]
                    && [facts[@"documentWebviews"] isEqual:@0] && [row[@"pluginHost"] isEqual:@YES],
                [NSString stringWithFormat:@"the window facts count the host web view as a plugin host web view: pluginHostWebviews %@, "
                    "appDomWebviews %@, documentWebviews %@, row pluginHost %@", facts[@"pluginHostWebviews"], facts[@"appDomWebviews"],
                    facts[@"documentWebviews"], row[@"pluginHost"]]);
            sp_document_close(host);
            check(view.superview == nil, @"the disposal of the host web view removes it from the window");
        }
        check(sp_plugin_host_create(NULL, store.fileSystemRepresentation, "/plugins/probe", "probe",
            "window.sokView = 1;", hostChanged, NULL) == NULL, @"a creation without a window fails");
        check(sp_plugin_host_create(window, store.fileSystemRepresentation, "/plugins/probe", "probe", NULL,
            hostChanged, NULL) == NULL, @"a creation without the channel script fails");
        [window close];
        [window release];
    }
    fprintf(stdout, "%s: plugin_host_view_test\n", failures == 0 ? "PASS" : "FAIL");
    return failures == 0 ? 0 : 1;
}
