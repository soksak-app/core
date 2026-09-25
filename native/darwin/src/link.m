#import <Cocoa/Cocoa.h>
#import "link.h"

char *sp_link_open(const char *url) {
    @autoreleasepool {
        if (!url) return strdup("link URL is missing");
        NSString *text = [NSString stringWithUTF8String:url];
        NSURL *target = text ? [NSURL URLWithString:text] : nil;
        if (!target || !target.scheme) return strdup("link URL does not parse");
        if (![[NSWorkspace sharedWorkspace] openURL:target]) {
            return strdup("the system did not open the link URL");
        }
        return NULL;
    }
}
