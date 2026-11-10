// Checks that the wake pipe opens readable when the ring already holds a record (docs/spec/logging.md#writers): an event that
// a producer stored before the host writer asked for the pipe wakes that writer at its first wait. It runs in its own process,
// since the pipe opens once for the process.
#import <Foundation/Foundation.h>
#include <errno.h>
#include <unistd.h>
#import "event_ring.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

int main(void) { @autoreleasepool {
    // The default policy stores errors, so this event reaches the ring before any policy or pipe exists.
    check(sp_event(SP_CLASS_LIFECYCLE, SP_EVENT_ERROR, "test.early", "{}"), @"an event before the pipe is stored");
    int wake = sp_event_wake_fd();
    check(wake >= 0, @"the wake pipe opens after the event");
    uint8_t bytes[64];
    ssize_t first = read(wake, bytes, sizeof bytes);
    check(first == 1, [NSString stringWithFormat:@"a pipe that opens while the ring holds a record is readable, got %zd", first]);
    check(read(wake, bytes, sizeof bytes) == -1 && errno == EAGAIN, @"the record that waited writes the pipe once");

    uint8_t pulled[4096];
    check(sp_event_drain(pulled, sizeof pulled) > 0, @"the drain that the wake causes takes the early record");
    check(read(wake, bytes, sizeof bytes) == -1 && errno == EAGAIN, @"a drain that takes everything leaves the pipe quiet");
    check(sp_event(SP_CLASS_LIFECYCLE, SP_EVENT_ERROR, "test.early", "{}"), @"an event after the drain is stored");
    check(read(wake, bytes, sizeof bytes) == 1, @"the event after the drain writes the pipe again");
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
}}
