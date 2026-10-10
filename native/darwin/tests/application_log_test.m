// The records of the native library are events of the process ring (docs/spec/logging.md#writers): sp_log_error and
// sp_log_info store `native.record.error` and `native.record.info` with the fields `where` and `text`. The host writer pulls
// them from the ring.
#import <Foundation/Foundation.h>
#include <time.h>
#import "application_log.h"
#import "event_ring.h"

/// The records that the process ring holds, decoded; a record that is not a JSON object stops the test.
static void pulled(NSMutableArray<NSString *> *names, NSMutableArray<NSDictionary *> *fieldsOf) {
    uint8_t buffer[1 << 16];
    size_t used = sp_event_drain(buffer, sizeof buffer);
    for (size_t offset = 0; offset < used;) {
        uint32_t length;
        memcpy(&length, buffer + offset, sizeof length);
        const uint8_t *body = buffer + offset + 4;
        uint8_t nameLength = body[9];
        [names addObject:[[NSString alloc] initWithBytes:body + 10 length:nameLength encoding:NSUTF8StringEncoding]];
        NSData *json = [NSData dataWithBytes:body + 10 + nameLength length:length - 10 - nameLength];
        NSError *error = nil;
        NSDictionary *fields = [NSJSONSerialization JSONObjectWithData:json options:0 error:&error];
        if (![fields isKindOfClass:NSDictionary.class]) { fprintf(stderr, "FAIL: the fields are not a JSON object: %s\n", error.localizedDescription.UTF8String); exit(1); }
        [fieldsOf addObject:fields];
        offset += 4 + length;
    }
}

static BOOL check(const char *name, BOOL passed, NSString *detail) {
    fprintf(passed ? stdout : stderr, "%s: %s (%s)\n", passed ? "PASS" : "FAIL", name, detail.UTF8String ?: "nothing");
    return passed;
}

int main(void) { @autoreleasepool {
    (void)sp_event_drain((uint8_t[64]){0}, 64);
    NSMutableArray<NSString *> *names = [NSMutableArray array];
    NSMutableArray<NSDictionary *> *fields = [NSMutableArray array];

    struct timespec wall;
    clock_gettime(CLOCK_REALTIME, &wall);
    sp_log_error("surface settle", "the DOM evaluation failed");
    sp_log_info("input method", "insertText text=\"한\"");
    sp_log_info("input method", "first\nsecond\ttab \\ backslash \x01 control");
    pulled(names, fields);
    BOOL ok = check("an error is the event native.record.error with where and text",
        names.count == 3 && [names[0] isEqualToString:@"native.record.error"] &&
        [fields[0][@"where"] isEqualToString:@"surface settle"] && [fields[0][@"text"] isEqualToString:@"the DOM evaluation failed"],
        names.description);
    ok = check("an observation is the event native.record.info and keeps quotes and Korean text",
        [names[1] isEqualToString:@"native.record.info"] && [fields[1][@"text"] isEqualToString:@"insertText text=\"한\""],
        fields.description) && ok;
    ok = check("a line feed, a tab, a backslash and a control character are kept in the text",
        [fields[2][@"text"] isEqualToString:@"first\nsecond\ttab \\ backslash \x01 control"], fields.description) && ok;

    // The time of the event is the time of the call.
    sp_log_info("time", "now");
    uint8_t buffer[256];
    size_t used = sp_event_drain(buffer, sizeof buffer);
    uint64_t ts;
    memcpy(&ts, buffer + 4, sizeof ts);
    struct timespec after;
    clock_gettime(CLOCK_REALTIME, &after);
    uint64_t low = (uint64_t)wall.tv_sec * 1000000u, high = (uint64_t)after.tv_sec * 1000000u + 999999u;
    ok = check("the event carries the wall clock of the call", used > 0 && ts >= low && ts <= high + 1000000u,
        [NSString stringWithFormat:@"%llu", ts]) && ok;

    // A text that cannot fit the ring is refused and counted, and the call returns.
    (void)sp_event_take_loss();
    size_t huge = 3u << 20;
    char *big = malloc(huge + 1);
    memset(big, 'x', huge);
    big[huge] = 0;
    sp_log_info("huge", big);
    free(big);
    sp_event_ring_loss loss = sp_event_take_loss();
    ok = check("a record larger than half of the ring is refused and counted", loss.events == 1,
        [NSString stringWithFormat:@"%llu events", loss.events]) && ok;
    return ok ? 0 : 1;
}}
