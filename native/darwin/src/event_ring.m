#import <Foundation/Foundation.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
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

// The capacity of the ring of the process: the events of a burst of PTY activity wait here until the writer of the host
// pulls them.
static const size_t processRingCapacity = 4u << 20;

static sp_event_ring *processRing(void) {
    static sp_event_ring *ring;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        ring = sp_event_ring_create(processRingCapacity);
    });
    return ring;
}

uint64_t sp_mono_ns(void) { return clock_gettime_nsec_np(CLOCK_UPTIME_RAW); }

// Whether the list of identifiers can be stored: no '"', no '\\' and no control character, so a host writes it as the strings
// of a JSON array without escaping, and at most what the 2-byte length of a record holds.
static bool validCids(const char *cids, size_t *length) {
    size_t count = strlen(cids);
    if (count > UINT16_MAX) return false;
    for (size_t index = 0; index < count; index++) {
        unsigned char c = (unsigned char)cids[index];
        if (c < 0x20 || c == 0x7f || c == '"' || c == '\\') return false;
    }
    *length = count;
    return true;
}

bool sp_event_cids(uint8_t level, const char *name, const char *cids, const char *fields_json) {
    sp_event_ring *ring = processRing();
    if (!ring) return false;
    size_t nameLength = name ? strlen(name) : 0;
    size_t cidsLength = 0;
    if (nameLength == 0 || nameLength > 255 || level > SP_EVENT_TRACE || !fields_json || !cids || !validCids(cids, &cidsLength)) {
        countLoss(ring, nameLength);
        return false;
    }
    size_t fieldsLength = strlen(fields_json);
    size_t length = SP_EVENT_HEADER_BYTES + nameLength + cidsLength + fieldsLength;
    // The record is built in place of a heap allocation for the usual event and in one allocation for a large one.
    uint8_t stack[512];
    uint8_t *record = length <= sizeof stack ? stack : malloc(length);
    if (!record) {
        countLoss(ring, length);
        return false;
    }
    struct timespec now;
    clock_gettime(CLOCK_REALTIME, &now);
    uint64_t micros = (uint64_t)now.tv_sec * 1000000u + (uint64_t)now.tv_nsec / 1000u;
    uint64_t mono = sp_mono_ns();
    uint16_t cidsField = (uint16_t)cidsLength;
    memcpy(record, &micros, sizeof micros);
    memcpy(record + 8, &mono, sizeof mono);
    record[16] = level;
    record[17] = (uint8_t)nameLength;
    memcpy(record + 18, &cidsField, sizeof cidsField);
    memcpy(record + SP_EVENT_HEADER_BYTES, name, nameLength);
    memcpy(record + SP_EVENT_HEADER_BYTES + nameLength, cids, cidsLength);
    memcpy(record + SP_EVENT_HEADER_BYTES + nameLength + cidsLength, fields_json, fieldsLength);
    bool stored = sp_event_ring_push(ring, record, length);
    if (record != stack) free(record);
    return stored;
}

bool sp_event(uint8_t level, const char *name, const char *fields_json) {
    // events: forwarded
    return sp_event_cids(level, name, "", fields_json);
}

// The boot identifier of the run: a string that is never changed or freed once published, so a reader on another thread
// holds a valid pointer. A replacement leaks the earlier one; the host sets it once.
static _Atomic(const char *) bootIdentifier;
static _Atomic uint64_t lastCid;

bool sp_event_set_boot(const char *boot) {
    size_t length = boot ? strlen(boot) : 0;
    if (length == 0 || length > 64) return false;
    for (size_t index = 0; index < length; index++) {
        char c = boot[index];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_')) return false;
    }
    const char *copy = strdup(boot);
    if (!copy) return false;
    atomic_store_explicit(&bootIdentifier, copy, memory_order_release);
    return true;
}

bool sp_cid_new(char *buffer, size_t capacity) {
    const char *boot = atomic_load_explicit(&bootIdentifier, memory_order_acquire);
    if (!boot || !buffer) return false;
    uint64_t next = atomic_fetch_add_explicit(&lastCid, 1, memory_order_relaxed) + 1;
    int written = snprintf(buffer, capacity, "%s.%llu", boot, (unsigned long long)next);
    if (written < 0 || (size_t)written >= capacity) {
        if (capacity > 0) buffer[0] = 0;
        return false;
    }
    return true;
}

size_t sp_event_drain(uint8_t *buffer, size_t capacity) {
    sp_event_ring *ring = processRing();
    return ring ? sp_event_ring_drain(ring, buffer, capacity) : 0;
}

sp_event_ring_loss sp_event_take_loss(void) {
    sp_event_ring *ring = processRing();
    sp_event_ring_loss none = {0, 0};
    return ring ? sp_event_ring_take_loss(ring) : none;
}
