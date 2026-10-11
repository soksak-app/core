// The event ring of the native library (docs/spec/logging.md#writers): many producer threads copy variable-length events
// into a bounded lock-free ring, and one consumer drains them. A full ring counts the loss and returns to the producer.
#import <Foundation/Foundation.h>
#import <pthread.h>
#include <stdatomic.h>
#include <time.h>
#import "event_ring.h"
#import "support/records.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

/// The events that one drain call returned, as strings: each event is a 4-byte length and the bytes.
static NSArray<NSString *> *drained(sp_event_ring *ring) {
    NSMutableArray *events = [NSMutableArray array];
    uint8_t buffer[4096];
    size_t used;
    while ((used = sp_event_ring_drain(ring, buffer, sizeof buffer)) > 0) {
        for (size_t offset = 0; offset < used;) {
            uint32_t length;
            memcpy(&length, buffer + offset, sizeof length);
            [events addObject:[[NSString alloc] initWithBytes:buffer + offset + 4 length:length encoding:NSUTF8StringEncoding]];
            offset += 4 + length;
        }
    }
    return events;
}

static void pushString(sp_event_ring *ring, NSString *text) {
    sp_event_ring_push(ring, text.UTF8String, strlen(text.UTF8String));
}

typedef struct {
    sp_event_ring *ring;
    int producer;
    int count;
} Producer;

static void *produce(void *argument) {
    Producer *producer = argument;
    char text[64];
    for (int index = 0; index < producer->count; index++) {
        int length = snprintf(text, sizeof text, "p%d:%d", producer->producer, index);
        // A full ring counts the loss; the producer tries again so that the test keeps every event.
        while (!sp_event_ring_push(producer->ring, text, (size_t)length)) sched_yield();
    }
    return NULL;
}

int main(void) { @autoreleasepool {
    // A pushed event comes back whole and in order.
    sp_event_ring *ring = sp_event_ring_create(1024);
    pushString(ring, @"first");
    pushString(ring, @"second event");
    pushString(ring, @"");
    check([drained(ring) isEqualToArray:(@[@"first", @"second event", @""])], @"events come back whole and in order");
    check([drained(ring) count] == 0, @"an empty ring drains nothing");

    // Events of any length up to the capacity are kept; the ring wraps many times.
    NSMutableArray *expected = [NSMutableArray array];
    NSMutableArray *got = [NSMutableArray array];
    for (int round = 0; round < 200; round++) {
        NSString *text = [@"" stringByPaddingToLength:(NSUInteger)(1 + (round * 37) % 300) withString:[NSString stringWithFormat:@"%d,", round] startingAtIndex:0];
        [expected addObject:text];
        pushString(ring, text);
        if (round % 3 == 2) [got addObjectsFromArray:drained(ring)];
    }
    [got addObjectsFromArray:drained(ring)];
    check([got isEqualToArray:expected], @"the ring keeps the order and the bytes across wraps");

    // A full ring returns false, counts the loss, and keeps what it holds.
    sp_event_ring *small = sp_event_ring_create(256);
    int accepted = 0;
    for (int index = 0; index < 100; index++) {
        char text[40];
        int length = snprintf(text, sizeof text, "event %d", index);
        if (sp_event_ring_push(small, text, (size_t)length)) accepted++;
    }
    sp_event_ring_loss loss = sp_event_ring_take_loss(small);
    check(accepted > 0 && accepted < 100 && loss.events == (uint64_t)(100 - accepted) && loss.bytes > 0,
        [NSString stringWithFormat:@"a full ring counts the lost events and bytes (accepted %d, lost %llu events, %llu bytes)", accepted,
            loss.events, loss.bytes]);
    check(sp_event_ring_take_loss(small).events == 0, @"taking the loss resets the counter");
    NSArray *kept = drained(small);
    check((int)kept.count == accepted && [kept.firstObject isEqualToString:@"event 0"],
        @"a full ring keeps the events it accepted");

    // An event larger than the capacity is refused and counted.
    char big[600];
    memset(big, 'x', sizeof big);
    check(!sp_event_ring_push(small, big, sizeof big) && sp_event_ring_take_loss(small).events == 1,
        @"an event larger than the ring is refused and counted");

    // Many producers and one consumer: every event arrives once, and the events of one producer keep their order.
    enum { producers = 8, perProducer = 20000 };
    sp_event_ring *shared = sp_event_ring_create(1 << 16);
    pthread_t threads[producers];
    Producer parameters[producers];
    for (int index = 0; index < producers; index++) {
        parameters[index] = (Producer){shared, index, perProducer};
        pthread_create(&threads[index], NULL, produce, &parameters[index]);
    }
    int next[producers] = {0};
    int total = 0;
    BOOL orderKept = YES;
    BOOL duplicate = NO;
    struct timespec start;
    clock_gettime(CLOCK_MONOTONIC, &start);
    while (total < producers * perProducer) {
        for (NSString *event in drained(shared)) {
            int producer, index;
            sscanf(event.UTF8String, "p%d:%d", &producer, &index);
            if (index != next[producer]) { orderKept = NO; if (index < next[producer]) duplicate = YES; }
            next[producer] = index + 1;
            total++;
        }
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        if (now.tv_sec - start.tv_sec > 60) break;
    }
    for (int index = 0; index < producers; index++) pthread_join(threads[index], NULL);
    check(total == producers * perProducer && !duplicate && orderKept,
        [NSString stringWithFormat:@"%d producers deliver every event once and in order (%d of %d)", producers, total, producers * perProducer]);


    // The ring of the process: sp_event stores the wall clock, the monotonic clock, the level, the name, the correlation
    // identifiers and the fields, and sp_event_drain returns them in order as records of ts_us (8 bytes), mono_ns (8), level
    // (1), name length (1), cids length (2), the name, the cids and the fields.
    struct timespec wall;
    clock_gettime(CLOCK_REALTIME, &wall);
    uint64_t before = (uint64_t)wall.tv_sec * 1000000u + (uint64_t)wall.tv_nsec / 1000u;
    uint64_t monoBefore = clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
    check(sp_event(SP_EVENT_WARN, "native.test.first", "{\"index\":1}") && sp_event(SP_EVENT_ERROR, "native.test.second", "{}"),
        @"sp_event accepts an event");
    clock_gettime(CLOCK_REALTIME, &wall);
    uint64_t after = (uint64_t)wall.tv_sec * 1000000u + (uint64_t)wall.tv_nsec / 1000u;
    uint64_t monoAfter = clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
    uint8_t pulled[1024];
    size_t used = sp_event_drain(pulled, sizeof pulled);
    uint32_t firstLength;
    memcpy(&firstLength, pulled, sizeof firstLength);
    NSDictionary *first = decodedRecord(pulled + 4, firstLength);
    uint64_t ts = [first[@"ts_us"] unsignedLongLongValue];
    uint64_t mono = [first[@"mono_ns"] unsignedLongLongValue];
    check(used > 0 && ts >= before && ts <= after && [first[@"level"] intValue] == SP_EVENT_WARN &&
            [first[@"name"] isEqualToString:@"native.test.first"] && [first[@"fields"] isEqualToDictionary:@{@"index": @1}] &&
            [first[@"cids"] count] == 0,
        [NSString stringWithFormat:@"a pulled record holds the time, the level, the name and the fields (%@)", first]);
    check(mono >= monoBefore && mono <= monoAfter && mono > 0,
        [NSString stringWithFormat:@"a pulled record holds the monotonic clock of the call (%llu in [%llu, %llu])", mono, monoBefore, monoAfter]);
    check(sp_mono_ns() >= monoAfter && sp_mono_ns() - monoAfter < 10u * 1000000000u,
        @"sp_mono_ns reads the clock of the records (CLOCK_UPTIME_RAW)");
    uint32_t secondLength;
    memcpy(&secondLength, pulled + 4 + firstLength, sizeof secondLength);
    check(used == 4 + firstLength + 4 + secondLength && [decodedRecord(pulled + 4 + firstLength + 4, secondLength)[@"level"] intValue] == SP_EVENT_ERROR,
        @"the second record follows the first in order");

    // A correlation identifier is assigned by the layer that first sees an input: <boot>.<n>, with n counting from 1.
    char cid[64];
    check(!sp_cid_new(cid, sizeof cid), @"an identifier cannot be assigned before the host gave the boot identifier");
    check(sp_event_set_boot("b3-7") && !sp_event_set_boot("") && !sp_event_set_boot("a,b") && !sp_event_set_boot("a\"b"),
        @"a boot identifier is accepted once it is made of letters, digits, '-' and '_'; an empty one or one with ',' or '\"' is refused");
    char second[64];
    check(sp_cid_new(cid, sizeof cid) && sp_cid_new(second, sizeof second) && strcmp(cid, "b3-7.1") == 0 && strcmp(second, "b3-7.2") == 0,
        [NSString stringWithFormat:@"identifiers count from 1 under the boot identifier (%s, %s)", cid, second]);
    char tiny[4];
    check(!sp_cid_new(tiny, sizeof tiny), @"an identifier that does not fit the buffer is refused");
    (void)sp_event_drain(pulled, sizeof pulled);
    check(sp_event_cids(SP_EVENT_INFO, "native.test.input", "b3-7.1,b3-7.2", "{\"k\":1}") && sp_event_cids(SP_EVENT_INFO, "native.test.none", "", "{}"),
        @"sp_event_cids accepts a list of identifiers and an empty list");
    used = sp_event_drain(pulled, sizeof pulled);
    uint32_t inputLength;
    memcpy(&inputLength, pulled, sizeof inputLength);
    NSDictionary *input = decodedRecord(pulled + 4, inputLength);
    uint32_t noneLength;
    memcpy(&noneLength, pulled + 4 + inputLength, sizeof noneLength);
    NSDictionary *none = decodedRecord(pulled + 4 + inputLength + 4, noneLength);
    check(used > 0 && [input[@"cids"] isEqualToArray:(@[@"b3-7.1", @"b3-7.2"])] && [input[@"fields"] isEqualToDictionary:@{@"k": @1}] &&
            [none[@"cids"] count] == 0 && [none[@"name"] isEqualToString:@"native.test.none"],
        [NSString stringWithFormat:@"a record carries its correlation identifiers (%@ %@)", input, none]);
    check(!sp_event_cids(SP_EVENT_INFO, "native.test.bad", "a\"b", "{}") && !sp_event_cids(SP_EVENT_INFO, "native.test.bad", NULL, "{}"),
        @"a list of identifiers with a quote, or none at all, is refused");
    (void)sp_event_take_loss();
    check(sp_event_drain(pulled, sizeof pulled) == 0, @"a drained process ring is empty");

    // A name that is missing, empty, longer than 255 bytes or not under a layer, an unknown level and fields that are
    // missing are refused and counted.
    char longName[300];
    memset(longName, 'a', sizeof longName);
    longName[sizeof longName - 1] = 0;
    (void)sp_event_take_loss();
    check(!sp_event(SP_EVENT_INFO, NULL, "{}") && !sp_event(SP_EVENT_INFO, "", "{}") && !sp_event(SP_EVENT_INFO, longName, "{}") &&
            !sp_event(99, "native.test.level", "{}") && !sp_event(SP_EVENT_INFO, "native.test.fields", NULL),
        @"an event with no name, an empty name, a name over 255 bytes, an unknown level or no fields is refused");
    check(sp_event_take_loss().events == 5, @"each refused event is counted");

    sp_event_ring_destroy(ring);
    sp_event_ring_destroy(small);
    sp_event_ring_destroy(shared);
    return failures ? 1 : 0;
}}
