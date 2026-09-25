#import <Cocoa/Cocoa.h>
#import "link.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// 열 수 있는 URL 은 사용자의 기본 애플리케이션을 띄우므로 이 검사는 여는 경로를 실행하지 않는다.
int main(void) { @autoreleasepool {
    char *missing = sp_link_open(NULL);
    check(missing && strcmp(missing, "link URL is missing") == 0, @"a missing URL is an error");
    free(missing);
    char *unparsed = sp_link_open("http://exa mple.test/");
    check(unparsed && strcmp(unparsed, "link URL does not parse") == 0, @"a URL that does not parse is an error");
    free(unparsed);
    return failures == 0 ? 0 : 1;
} }
