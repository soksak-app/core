// 시스템 알림 모듈을 검사한다. 알림 센터는 애플리케이션 번들에서 실행된 프로세스만 받으므로, 같은 검사를
// 번들 밖에서 실행해 시작이 명시적 오류로 실패하는지 보고(인자 없음), 번들 안에서 실행해 권한 상태를 한 번
// 알리는지 본다(--bundled). 권한을 요청하거나 알림을 게시하지 않는다. 애플리케이션을 활성화하지 않는다.
#import <Cocoa/Cocoa.h>
#import "notifications.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void received(void *context, const char *json) {
    [(NSMutableArray *)context addObject:[NSString stringWithUTF8String:json]];
}

int main(int argc, char **argv) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    BOOL bundled = argc > 1 && strcmp(argv[1], "--bundled") == 0;
    NSMutableArray<NSString *> *events = [NSMutableArray array];
    const char *error = sp_notifications_start(received, events);
    if (!bundled) {
        check(error != NULL && strstr(error, "application bundle") != NULL,
            [NSString stringWithFormat:@"notifications outside a bundle fail to start explicitly (got %s)", error ?: "no error"]);
        return failures ? 1 : 0;
    }
    check(error == NULL, [NSString stringWithFormat:@"notifications start in a bundle (got %s)", error ?: "no error"]);
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (events.count == 0 && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
    }
    NSDictionary *state = events.count ? [NSJSONSerialization JSONObjectWithData:[events[0] dataUsingEncoding:NSUTF8StringEncoding]
        options:0 error:NULL] : nil;
    NSArray *names = @[@"notDetermined", @"denied", @"authorized", @"provisional"];
    check([state[@"type"] isEqual:@"state"] && [names containsObject:state[@"authorization"]] && state[@"error"] == NSNull.null,
        [NSString stringWithFormat:@"starting reports the authorization once as a state event (got %@)", events]);
    check(sp_notifications_start(received, events) != NULL, @"a second start fails explicitly");
    return failures ? 1 : 0;
}}
