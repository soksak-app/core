#import <Cocoa/Cocoa.h>
#import "link.h"
#import "application_log.h"

// Stores the reason as an error record and returns it as the failure text of the caller.
static char *refuse(const char *reason) {
    sp_log_error("link", reason);
    return strdup(reason);
}

char *sp_link_open(const char *url) {
    @autoreleasepool {
        if (!url) return refuse("link URL is missing");
        NSString *text = [NSString stringWithUTF8String:url];
        NSURL *target = text ? [NSURL URLWithString:text] : nil;
        if (!target || !target.scheme) return refuse("link URL does not parse");
        if (![[NSWorkspace sharedWorkspace] openURL:target]) {
            return refuse("the system did not open the link URL");
        }
        return NULL;
    }
}
