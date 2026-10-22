// Checks that a web view creation that fails reports its native cause through sp_document_last_error. A data store directory
// that cannot be created names the directory and the error of the file system, so the host error names the cause.
#import <Cocoa/Cocoa.h>
#import "document_view.h"

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
        void *host = sp_plugin_host_create((__bridge void *)window, "/dev/null/soksak-store", "/tmp", "probe", "", changed, NULL);
        check(host == NULL, @"a data store under a file is not created");
        NSString *cause = [NSString stringWithUTF8String:sp_document_last_error()];
        check([cause hasPrefix:@"cannot create the data store directory /dev/null/soksak-store: "],
            [NSString stringWithFormat:@"the failure names the directory and its error: %@", cause]);
    }
    return failures == 0 ? 0 : 1;
}
