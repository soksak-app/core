#import <Foundation/Foundation.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#import "event_ring.h"

// A record is an 8-byte header and the bytes of the event, padded to a multiple of 8. The header holds the length of the
// whole record (0 while the producer has only reserved it) and the kind of the record. A record never wraps: when the
// event does not fit before the end of the buffer, the producer reserves a padding record up to the end and the event
// at the start. The consumer zeroes what it consumed, so a length of 0 means that nothing is published there yet.

enum { kindEvent = 1, kindPadding = 2 };
enum { headerBytes = 8, alignment = 8 };

typedef struct {
    _Atomic uint32_t length;
    uint32_t kind;
} Header;

struct sp_event_ring {
    uint8_t *buffer;
    size_t capacity;
    size_t mask;
    // Positions only grow; the offset in the buffer is the position masked. head belongs to the consumer, tail to the
    // producers.
    _Atomic uint64_t head;
    _Atomic uint64_t tail;
    _Atomic uint64_t lostEvents;
    _Atomic uint64_t lostBytes;
};

static size_t align(size_t value) { return (value + alignment - 1) & ~(size_t)(alignment - 1); }

sp_event_ring *sp_event_ring_create(size_t capacity) {
    size_t rounded = 64;
    while (rounded < capacity) rounded <<= 1;
    sp_event_ring *ring = calloc(1, sizeof *ring);
    if (!ring) return NULL;
    ring->buffer = calloc(1, rounded);
    if (!ring->buffer) {
        free(ring);
        return NULL;
    }
    ring->capacity = rounded;
    ring->mask = rounded - 1;
    return ring;
}

void sp_event_ring_destroy(sp_event_ring *ring) {
    if (!ring) return;
    free(ring->buffer);
    free(ring);
}

static void countLoss(sp_event_ring *ring, size_t length) {
    atomic_fetch_add_explicit(&ring->lostEvents, 1, memory_order_relaxed);
    atomic_fetch_add_explicit(&ring->lostBytes, length, memory_order_relaxed);
}

bool sp_event_ring_push(sp_event_ring *ring, const void *bytes, size_t length) {
    size_t record = align(headerBytes + length);
    // A record is limited by the 32-bit length field and by half of the buffer, so that padding and event fit together.
    if (record > ring->capacity / 2 || record > UINT32_MAX) {
        countLoss(ring, length);
        return false;
    }
    uint64_t tail = atomic_load_explicit(&ring->tail, memory_order_relaxed);
    for (;;) {
        uint64_t head = atomic_load_explicit(&ring->head, memory_order_acquire);
        size_t index = (size_t)(tail & ring->mask);
        size_t toEnd = ring->capacity - index;
        size_t padding = record > toEnd ? toEnd : 0;
        size_t needed = record + padding;
        if (ring->capacity - (size_t)(tail - head) < needed) {
            countLoss(ring, length);
            return false;
        }
        if (!atomic_compare_exchange_weak_explicit(&ring->tail, &tail, tail + needed, memory_order_relaxed, memory_order_relaxed)) {
            continue;
        }
        if (padding > 0) {
            Header *pad = (Header *)(ring->buffer + index);
            pad->kind = kindPadding;
            atomic_store_explicit(&pad->length, (uint32_t)padding, memory_order_release);
            index = 0;
        }
        Header *header = (Header *)(ring->buffer + index);
        header->kind = kindEvent;
        if (length > 0) memcpy(ring->buffer + index + headerBytes, bytes, length);
        // The length is published last, so a consumer that reads a length reads a complete record.
        atomic_store_explicit(&header->length, (uint32_t)(headerBytes + length), memory_order_release);
        return true;
    }
}

size_t sp_event_ring_drain(sp_event_ring *ring, uint8_t *buffer, size_t capacity) {
    size_t written = 0;
    uint64_t head = atomic_load_explicit(&ring->head, memory_order_relaxed);
    for (;;) {
        size_t index = (size_t)(head & ring->mask);
        Header *header = (Header *)(ring->buffer + index);
        uint32_t length = atomic_load_explicit(&header->length, memory_order_acquire);
        if (length == 0) break;
        size_t record = align(length);
        if (header->kind == kindEvent) {
            size_t payload = length - headerBytes;
            if (written + 4 + payload > capacity) break;
            uint32_t size = (uint32_t)payload;
            memcpy(buffer + written, &size, sizeof size);
            if (payload > 0) memcpy(buffer + written + 4, ring->buffer + index + headerBytes, payload);
            written += 4 + payload;
        }
        // Zero what was consumed so that a length of 0 again means "not published", then give the room back.
        memset(ring->buffer + index, 0, record);
        head += record;
        atomic_store_explicit(&ring->head, head, memory_order_release);
    }
    return written;
}

sp_event_ring_loss sp_event_ring_take_loss(sp_event_ring *ring) {
    sp_event_ring_loss loss;
    loss.events = atomic_exchange_explicit(&ring->lostEvents, 0, memory_order_relaxed);
    loss.bytes = atomic_exchange_explicit(&ring->lostBytes, 0, memory_order_relaxed);
    return loss;
}
