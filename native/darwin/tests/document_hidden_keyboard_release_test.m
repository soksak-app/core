// Checks that a hidden surface does not keep the document that held the keyboard (docs/spec/hosts.md#native-views): a surface that
// hides notes the view that held the keyboard so that it gives the keyboard back when it shows, and a document of that surface
// that closes while the surface is hidden is still released, so its web view ends its page and its web content process.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import "support/temporary_folder.h"
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

// A marker that the document holds as an associated object, so its release marks the release of the document.
static BOOL documentReleased;

@interface DocumentReleaseMarker : NSObject
@end

@implementation DocumentReleaseMarker
- (void)dealloc {
    documentReleased = YES;
    [super dealloc];
}
@end

static char kDocumentReleaseMarker;

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSString *temporary = temporaryFolder(@"soksak-document-hidden-keyboard-release-");
    NSString *folder = [temporary stringByAppendingPathComponent:@"plugin"];
    [[NSFileManager defaultManager] createDirectoryAtPath:folder withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *store = [temporary stringByAppendingPathComponent:@"store"];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    [window orderBack:nil];

    void *surface = NULL;
    void *document = NULL;
    // Every autoreleased reference of the creation ends with this pool, so only the owners keep the document.
    @autoreleasepool {
        surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
        webviewSetFrame(surface, 0, 0, 500, 400);
        webviewSetSurfaceHidden(surface, false);
        document = sp_document_create(surface, store.fileSystemRepresentation, folder.fileSystemRepresentation, "probe", NULL, NULL, changed, NULL);
        if (document) {
            DocumentReleaseMarker *marker = [DocumentReleaseMarker new];
            objc_setAssociatedObject((id)document, &kDocumentReleaseMarker, marker, OBJC_ASSOCIATION_RETAIN);
            [marker release];
            sp_document_place(document, 0, 0, 0, 0, true);
        }
    }
    check(document != NULL, @"a document region is created on the surface");
    if (!document) return 1;

    @autoreleasepool {
        [window makeFirstResponder:(NSView *)document];
    }
    check(window.firstResponder == (NSView *)document, @"the document holds the keyboard of the window");

    // The hide notes the document as the view that held the keyboard, as a layout transaction hides a surface before its view
    // document leaves.
    @autoreleasepool {
        webviewSetSurfaceHidden(surface, true);
    }
    check(window.firstResponder != (NSView *)document, @"the hidden surface took the keyboard from the document");

    @autoreleasepool {
        sp_document_close(document);
    }
    // WebKit can release the last references of a closed web view on a later turn of the main run loop.
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5];
    while (!documentReleased && deadline.timeIntervalSinceNow > 0) {
        @autoreleasepool {
            [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
        }
    }
    check(documentReleased, @"a document that closes while its hidden surface notes it as the keyboard owner is released");

    // The surface shows again with nothing to give back.
    @autoreleasepool {
        webviewSetSurfaceHidden(surface, false);
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    check(window.firstResponder != (NSView *)document, @"the surface that shows again gives the keyboard to no closed document");

    @autoreleasepool {
        sp_surface_close(surface);
    }
    [window close];
    [window release];
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
}}
