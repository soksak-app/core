#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

#import "appearance.h"
#import "support/records.h"

static void check(BOOL condition, NSString *message) {
    if (!condition) {
        NSLog(@"FAIL: %@", message);
        exit(1);
    }
    NSLog(@"PASS: %@", message);
}

int main(void) {
    @autoreleasepool {
        WKWebView *view = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 100, 100)];
        check(sp_webview_set_appearance(view, true), @"dark appearance is applied by the native helper");
        check([view.appearance.name isEqual:NSAppearanceNameDarkAqua], @"dark appearance name is exact");
        check(sp_webview_set_appearance(view, false), @"light appearance is applied by the native helper");
        check([view.appearance.name isEqual:NSAppearanceNameAqua], @"light appearance name is exact");
        __block bool refused = true;
        NSArray<NSDictionary *> *events = capturedEvents(^{ refused = sp_webview_set_appearance(NULL, true); });
        check(!refused, @"a null view is an explicit failure");
        check(events.count == 1 && [events[0][@"name"] isEqual:@"native.record.error"] && [events[0][@"fields"][@"where"] isEqual:@"appearance"],
            @"the refusal is one error record of the place appearance");
    }
    return 0;
}
