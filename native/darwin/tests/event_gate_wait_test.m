// Checks that a count of a closed gate waits before it wakes a writer that sleeps (docs/spec/logging.md#policy).
#import <Foundation/Foundation.h>
#include <errno.h>
#include <unistd.h>
#import "event_ring.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    printf("%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

int main(void) { @autoreleasepool {
    int wake = sp_event_wake_fd();
    check(wake >= 0, @"the wake pipe opens");
    uint8_t bytes[64];
    uint8_t pulled[4096];
    while (sp_event_drain(pulled, sizeof pulled) > 0) {}
    while (read(wake, bytes, sizeof bytes) > 0) {}

    sp_event_set_gated_wait_ms(200);
    const int8_t closed[SP_CLASS_COUNT] = {-1, -1, -1, -1, -1};
    check(sp_event_set_policy(closed), @"a policy that closes every class is accepted");
    for (int index = 0; index < 5; index++) (void)sp_event_gate(SP_CLASS_INPUT, SP_EVENT_DEBUG);
    usleep(50 * 1000);
    check(read(wake, bytes, sizeof bytes) == -1 && errno == EAGAIN, @"a count leaves the pipe quiet during its wait");
    usleep(300 * 1000);
    check(read(wake, bytes, sizeof bytes) == 1, @"a count writes the pipe once after its wait");

    size_t used = sp_event_drain(pulled, sizeof pulled);
    check(used > 0, @"the drain that the wake causes reports the count");
    usleep(300 * 1000);
    check(read(wake, bytes, sizeof bytes) == -1 && errno == EAGAIN, @"the report leaves the pipe quiet");

    (void)sp_event_gate(SP_CLASS_INPUT, SP_EVENT_DEBUG);
    usleep(50 * 1000);
    used = sp_event_drain(pulled, sizeof pulled);
    check(used == 0, @"a drain within a second of the report reports no count");
    usleep(1100 * 1000);
    used = sp_event_drain(pulled, sizeof pulled);
    check(used > 0, @"a drain for another reason takes the count that waits");
    while (read(wake, bytes, sizeof bytes) > 0) {}
    usleep(300 * 1000);
    check(read(wake, bytes, sizeof bytes) == -1 && errno == EAGAIN, @"a wake that finds no count left writes nothing");
    return failures ? 1 : 0;
}}
