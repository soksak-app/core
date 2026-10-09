// A bounded lock-free ring for many producer threads and one consumer (docs/spec/logging.md#writers). A producer copies
// a variable-length event into the ring without a lock, an allocation or a system call; a full ring returns false and
// counts the loss. The consumer drains whole events into a buffer.

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct sp_event_ring sp_event_ring;

// The events and bytes that a full ring refused since the loss was last taken.
typedef struct {
    uint64_t events;
    uint64_t bytes;
} sp_event_ring_loss;

// Creates a ring that holds at least `capacity` bytes (rounded up to a power of two, at least 64). Returns NULL when the
// memory cannot be allocated.
sp_event_ring *sp_event_ring_create(size_t capacity);
void sp_event_ring_destroy(sp_event_ring *ring);

// Copies `length` bytes into the ring as one event. Returns false, and counts the loss, when the ring has no room or the
// event can never fit. Safe from any thread.
bool sp_event_ring_push(sp_event_ring *ring, const void *bytes, size_t length);

// Moves whole events into `buffer` (at most `capacity` bytes) and returns the number of bytes written. Each event is a
// 4-byte length in host byte order and its bytes. Returns 0 when the ring is empty or when the next event does not fit
// in the buffer. Only one thread drains.
size_t sp_event_ring_drain(sp_event_ring *ring, uint8_t *buffer, size_t capacity);

// Returns the loss counted since the last call and resets it.
sp_event_ring_loss sp_event_ring_take_loss(sp_event_ring *ring);
