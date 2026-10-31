// Checks that a document region keeps its surface while it observes it (docs/spec/native-surfaces.md#document-regions): a
// document observes the appearance of its surface, so a surface that the host closes before the document stays alive until
// the document closes, the close of the document removes its observation from a live surface, and the surface is released
// after the document closed.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import "support/temporary_folder.h"
#import "document_view.h"
#import "webview_geometry.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void changed(void *context, const char *text) {
    (void)context;
    (void)text;
}

// A marker that the surface holds as an associated object, so its release marks the release of the surface.
static BOOL surfaceReleased;

@interface SurfaceReleaseMarker : NSObject
@end

@implementation SurfaceReleaseMarker
- (void)dealloc {
    surfaceReleased = YES;
    [super dealloc];
}
@end

static char kSurfaceReleaseMarker;

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSString *temporary = temporaryFolder(@"soksak-document-surface-lifetime-");
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
    // Every autoreleased reference of the creation ends with this pool, so only the owners keep the surface.
    @autoreleasepool {
        surface = sp_surface_create(main);
        webviewSetFrame(surface, 0, 0, 500, 400);
        webviewSetSurfaceHidden(surface, false);
        SurfaceReleaseMarker *marker = [SurfaceReleaseMarker new];
        objc_setAssociatedObject((id)surface, &kSurfaceReleaseMarker, marker, OBJC_ASSOCIATION_RETAIN);
        [marker release];
        document = sp_document_create(surface, store.fileSystemRepresentation, folder.fileSystemRepresentation, "probe", NULL, changed, NULL);
    }
    check(document != NULL, @"a document region is created on the surface");
    if (!document) return 1;

    @autoreleasepool {
        sp_surface_close(surface);
    }
    check(!surfaceReleased, @"a surface that closes before its document stays alive while the document observes it");
    // A released surface is the state in which the close of the document messages a released object, so the check ends
    // here instead of crashing in that close.
    if (surfaceReleased) {
        fprintf(stderr, "%d failures\n", failures);
        return 1;
    }

    @autoreleasepool {
        sp_document_close(document);
    }
    check(surfaceReleased, @"the surface is released after its document closed");

    [window close];
    [window release];
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
}}
