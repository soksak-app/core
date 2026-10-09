// The cost of one record on the calling thread: the present text record (`sp_log_info`, which formats the line and calls
// write(2)) against a push into the event ring. The numbers are measured, not asserted (docs/spec/logging.md#writers).
#import <Foundation/Foundation.h>
#import <pthread.h>
#include <time.h>
#import "application_log.h"
#import "event_ring.h"

static uint64_t nowNs(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (uint64_t)t.tv_sec * 1000000000ull + (uint64_t)t.tv_nsec;
}

static int compare(const void *a, const void *b) {
    uint64_t x = *(const uint64_t *)a, y = *(const uint64_t *)b;
    return x < y ? -1 : x > y;
}

static void report(const char *name, uint64_t *samples, int count) {
    qsort(samples, (size_t)count, sizeof *samples, compare);
    uint64_t sum = 0;
    for (int i = 0; i < count; i++) sum += samples[i];
    fprintf(stdout, "%-34s mean %7llu ns  p50 %7llu ns  p99 %7llu ns  max %9llu ns\n", name, sum / (uint64_t)count,
        samples[count / 2], samples[(count * 99) / 100], samples[count - 1]);
}

typedef struct { sp_event_ring *ring; volatile int *stop; } Drainer;

static void *drain(void *argument) {
    Drainer *drainer = argument;
    uint8_t buffer[1 << 16];
    while (!*drainer->stop) {
        if (sp_event_ring_drain(drainer->ring, buffer, sizeof buffer) == 0) sched_yield();
    }
    return NULL;
}

int main(int argc, char **argv) { @autoreleasepool {
    enum { count = 200000 };
    static uint64_t samples[count];
    // The present text record goes to the standard error; the benchmark sends it to /dev/null as a file does.
    freopen("/dev/null", "w", stderr);
    for (int i = 0; i < count; i++) {
        uint64_t start = nowNs();
        sp_log_info("input method", "{\"call\":\"keyDown\",\"keyCode\":36,\"characters\":\"\\r\",\"before\":{\"document\":\"\"}}");
        samples[i] = nowNs() - start;
    }
    report("sp_log_info (format + write(2))", samples, count);

    // The ring with a consumer that drains concurrently, as the host writer does.
    sp_event_ring *ring = sp_event_ring_create(1 << 22);
    volatile int stop = 0;
    pthread_t consumer;
    Drainer drainer = {ring, &stop};
    pthread_create(&consumer, NULL, drain, &drainer);
    const char *event = "{\"event\":\"native.input.key_down\",\"fields\":{\"keyCode\":36,\"characters\":\"\\r\",\"before\":{\"document\":\"\"}}}";
    size_t length = strlen(event);
    for (int i = 0; i < count; i++) {
        uint64_t start = nowNs();
        sp_event_ring_push(ring, event, length);
        samples[i] = nowNs() - start;
    }
    report("sp_event_ring_push (copy)", samples, count);
    sp_event_ring_loss loss = sp_event_ring_take_loss(ring);
    fprintf(stdout, "lost events during the push run: %llu\n", loss.events);
    stop = 1;
    pthread_join(consumer, NULL);
    sp_event_ring_destroy(ring);
    return 0;
}}
