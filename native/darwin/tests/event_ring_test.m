// The event ring of the native library (docs/spec/logging.md#writers): many producer threads copy variable-length events
// into a bounded lock-free ring, and one consumer drains them. A full ring counts the loss and returns to the producer.
#import <Foundation/Foundation.h>
#import <pthread.h>
#include <stdatomic.h>
#include <time.h>
#import "event_ring.h"

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

    sp_event_ring_destroy(ring);
    sp_event_ring_destroy(small);
    sp_event_ring_destroy(shared);
    return failures ? 1 : 0;
}}
