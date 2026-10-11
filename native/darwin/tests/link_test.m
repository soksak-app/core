#import <Cocoa/Cocoa.h>
#import "link.h"
#import "support/records.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// A URL that can be opened launches the user's default application, so this check does not run the open path.
int main(void) { @autoreleasepool {
    __block char *missing = NULL;
    NSArray<NSDictionary *> *refused = capturedEvents(^{ missing = sp_link_open(NULL); });
    check(refused.count == 1 && [refused[0][@"name"] isEqual:@"native.record.error"] && [refused[0][@"fields"][@"where"] isEqual:@"link"]
        && [refused[0][@"fields"][@"text"] isEqual:@"link URL is missing"], @"a refused link is one error record that states the reason");
    check(missing && strcmp(missing, "link URL is missing") == 0, @"a missing URL is an error");
    free(missing);
    char *unparsed = sp_link_open("http://exa mple.test/");
    check(unparsed && strcmp(unparsed, "link URL does not parse") == 0, @"a URL that does not parse is an error");
    free(unparsed);
    return failures == 0 ? 0 : 1;
} }
