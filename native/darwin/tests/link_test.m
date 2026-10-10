#import <Cocoa/Cocoa.h>
#import "link.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// A URL that can be opened launches the user's default application, so this check does not run the open path.
int main(void) { @autoreleasepool {
    char *missing = sp_link_open(NULL);
    check(missing && strcmp(missing, "link URL is missing") == 0, @"a missing URL is an error");
    free(missing);
    char *unparsed = sp_link_open("http://exa mple.test/");
    check(unparsed && strcmp(unparsed, "link URL does not parse") == 0, @"a URL that does not parse is an error");
    free(unparsed);
    return failures == 0 ? 0 : 1;
} }
