// Checks that a document region creation that fails reports its native cause through sp_document_last_error. A data store directory
// that cannot be created names the directory and the error of the file system, so the host error names the cause.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
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

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 100, 100)
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        [window setReleasedWhenClosed:NO];
        WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
        [window.contentView addSubview:main];
        void *surface = sp_surface_create(main);
        check(surface != NULL, @"a logical surface is created for the document");
        void *document = sp_document_create(surface, "/dev/null/soksak-store", "/tmp", "probe", "", changed, NULL);
        check(document == NULL, @"a data store under a file is not created");
        NSString *cause = [NSString stringWithUTF8String:sp_document_last_error()];
        check([cause hasPrefix:@"cannot create the data store directory /dev/null/soksak-store: "],
            [NSString stringWithFormat:@"the failure names the directory and its error: %@", cause]);
    }
    return failures == 0 ? 0 : 1;
}
