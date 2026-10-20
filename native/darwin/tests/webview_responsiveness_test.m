// Checks that the private navigation delegate protocol declares the responsiveness selectors that WebKit calls when a
// WebContent process stops or resumes answering its responsiveness check. The check reads the declarations of the protocol
// in src/private/webkit.h; it does not start a web view and does not activate the application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import "private/webkit.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Returns whether the protocol declares an optional instance method with the selector.
static BOOL declaresOptionalMethod(Protocol *protocol, SEL selector) {
    struct objc_method_description description = protocol_getMethodDescription(protocol, selector, NO, YES);
    return description.name != NULL;
}

int main(void) { @autoreleasepool {
    SEL unresponsive = NSSelectorFromString(@"_webViewWebProcessDidBecomeUnresponsive:");
    SEL responsive = NSSelectorFromString(@"_webViewWebProcessDidBecomeResponsive:");

    check(declaresOptionalMethod(@protocol(SPNavigationDelegatePrivate), unresponsive),
        @"SPNavigationDelegatePrivate declares _webViewWebProcessDidBecomeUnresponsive:");
    check(declaresOptionalMethod(@protocol(SPNavigationDelegatePrivate), responsive),
        @"SPNavigationDelegatePrivate declares _webViewWebProcessDidBecomeResponsive:");

    // The selectors are optional: WebKit checks respondsToSelector: before it sends them, so a delegate that
    // implements the public protocol only does not conform to the required part of the private protocol.
    check(!protocol_getMethodDescription(@protocol(SPNavigationDelegatePrivate), unresponsive, YES, YES).name,
        @"the unresponsive selector is not a required method of SPNavigationDelegatePrivate");
    check(!protocol_getMethodDescription(@protocol(SPNavigationDelegatePrivate), responsive, YES, YES).name,
        @"the responsive selector is not a required method of SPNavigationDelegatePrivate");

    return failures ? 1 : 0;
}}
