// Checks that a hidden surface does not keep the document that held the keyboard (docs/spec/hosts.md#native-views): a surface that
// hides notes the view that held the keyboard so that it gives the keyboard back when it shows, and a document of that surface
// that closes while the surface is hidden is still released, so its web view ends its page and its web content process. A document
// that holds the keyboard and closes on a shown surface is the control: it tells a hold of the hide path from one of the keyboard.
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

// A marker that a document holds as an associated object, so its release sets the flag of that document.
@interface DocumentReleaseMarker : NSObject
@property(nonatomic, assign) BOOL *released;
@end

@implementation DocumentReleaseMarker
- (void)dealloc {
    *_released = YES;
    [super dealloc];
}
@end

static char kDocumentReleaseMarker;

// Creates a shown document on surface whose release sets released. Every autoreleased reference of the creation ends with the pool
// of the call, so only the owners keep the document.
static void *shownDocument(void *surface, NSString *store, NSString *folder, BOOL *released) {
    void *document = NULL;
    @autoreleasepool {
        document = sp_document_create(surface, store.fileSystemRepresentation, folder.fileSystemRepresentation, "probe", NULL, NULL, changed, NULL);
        if (document) {
            DocumentReleaseMarker *marker = [DocumentReleaseMarker new];
            marker.released = released;
            objc_setAssociatedObject((id)document, &kDocumentReleaseMarker, marker, OBJC_ASSOCIATION_RETAIN);
            [marker release];
            sp_document_place(document, 0, 0, 0, 0, true);
        }
    }
    return document;
}

// Reports whether the first responder of window is view. The read runs in its own pool, so an accessor that returns its value
// autoreleased leaves no reference to the view in the pool of the test.
static BOOL holdsKeyboard(NSWindow *window, void *view) {
    BOOL holds;
    @autoreleasepool {
        holds = window.firstResponder == (NSResponder *)view;
    }
    return holds;
}

// Gives view the keyboard of window.
static void giveKeyboard(NSWindow *window, void *view) {
    @autoreleasepool {
        [window makeFirstResponder:(NSView *)view];
    }
}

// Closes document and waits until it is released, as WebKit can release the last references of a closed web view on a later turn of
// the main run loop. Each turn runs in its own pool, which it drains. A document that stays names its retain count and its superview.
static void closeAndWait(void *document, const BOOL *released, NSString *message) {
    @autoreleasepool {
        sp_document_close(document);
    }
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5];
    while (!*released && deadline.timeIntervalSinceNow > 0) {
        @autoreleasepool {
            [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
        }
    }
    if (!*released) {
        // The marker was not released, so the document is alive and can be asked.
        NSView *view = (NSView *)document;
        fprintf(stderr, "the document %p stays with retain count %lu and superview %p\n", document,
            (unsigned long)view.retainCount, (void *)view.superview);
    }
    check(*released, message);
}

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
    @autoreleasepool {
        surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
        webviewSetFrame(surface, 0, 0, 500, 400);
        webviewSetSurfaceHidden(surface, false);
    }

    // The control: a document that holds the keyboard and closes on a shown surface.
    BOOL shownReleased = NO;
    void *shown = shownDocument(surface, store, folder, &shownReleased);
    check(shown != NULL, @"a document region is created on the shown surface");
    if (!shown) return 1;
    giveKeyboard(window, shown);
    check(holdsKeyboard(window, shown), @"the document of the shown surface holds the keyboard of the window");
    closeAndWait(shown, &shownReleased, @"a document that holds the keyboard and closes on a shown surface is released");

    BOOL hiddenReleased = NO;
    void *document = shownDocument(surface, store, folder, &hiddenReleased);
    check(document != NULL, @"a document region is created on the surface");
    if (!document) return 1;
    giveKeyboard(window, document);
    check(holdsKeyboard(window, document), @"the document holds the keyboard of the window");

    // The hide notes the document as the view that held the keyboard, as a layout transaction hides a surface before its view
    // document leaves.
    @autoreleasepool {
        webviewSetSurfaceHidden(surface, true);
    }
    check(!holdsKeyboard(window, document), @"the hidden surface took the keyboard from the document");
    closeAndWait(document, &hiddenReleased, @"a document that closes while its hidden surface notes it as the keyboard owner is released");

    // The surface shows again with nothing to give back. A released document is compared by its address only.
    @autoreleasepool {
        webviewSetSurfaceHidden(surface, false);
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    check(!holdsKeyboard(window, document), @"the surface that shows again gives the keyboard to no closed document");

    @autoreleasepool {
        sp_surface_close(surface);
    }
    [window close];
    [window release];
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
}}
