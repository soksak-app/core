// A bounded lock-free ring for many producer threads and one consumer (docs/spec/logging.md#writers). A producer copies
// a variable-length event into the ring without a lock, an allocation or a system call; a full ring returns false and
// counts the loss. The consumer drains whole events into a buffer.

#pragma once

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

// The ring of this process (docs/spec/logging.md#writers). It is created on the first call, so an event produced before
// the writer of the host exists waits in it. Every thread of the process may call sp_event; the writer of the host drains.
enum { SP_EVENT_ERROR = 0, SP_EVENT_WARN = 1, SP_EVENT_INFO = 2, SP_EVENT_DEBUG = 3, SP_EVENT_TRACE = 4 };

// The monotonic clock of the records in nanoseconds: `clock_gettime_nsec_np(CLOCK_UPTIME_RAW)`, which is mach_absolute_time
// converted to nanoseconds. It is comparable across the processes of one boot, does not step, and does not advance while
// the machine sleeps.
uint64_t sp_mono_ns(void);

// Stores an event: the wall clock in microseconds, the monotonic clock, the level, the name (1 to 255 bytes) and the
// fields as JSON text. It copies the arguments, does not wait, and returns false, and counts the loss, for a missing or
// empty or too long name, a level outside the enumeration, missing fields, a full ring, or an event that can never fit.
bool sp_event(uint8_t level, const char *name, const char *fields_json);

// Stores an event like sp_event, with the correlation identifiers of the inputs it belongs to: `cids` is a list of
// identifiers separated by ',' (an empty list for none). A missing list, a list over 65535 bytes, and a list with a '"', a
// '\\' or a control character are refused and counted like a refused name.
bool sp_event_cids(uint8_t level, const char *name, const char *cids, const char *fields_json);

// Sets the boot identifier of the run, which the host chose for its event files: letters, digits, '-' and '_' (at most 64
// bytes). The correlation identifiers of this process are `<boot>.<n>`. Returns false, and keeps the earlier identifier, for
// a missing, empty or longer identifier or one with another character.
bool sp_event_set_boot(const char *boot);

// Writes the next correlation identifier `<boot>.<n>` (n counts from 1 in this process) as a string to `buffer` and returns
// true. Returns false, and writes nothing, when the boot identifier is not set or the buffer is too small. Safe from any
// thread.
bool sp_cid_new(char *buffer, size_t capacity);

// Moves whole records of the process ring into `buffer`, as sp_event_drain does. A record is, in host byte order, the wall
// clock in microseconds (8 bytes), the monotonic clock in nanoseconds (8), the level (1), the length of the name (1), the
// length of the cids (2), the name, the cids (the list of sp_event_cids) and the fields.
enum { SP_EVENT_HEADER_BYTES = 20 };
size_t sp_event_drain(uint8_t *buffer, size_t capacity);

// Returns the loss of the process ring since the last call and resets it.
sp_event_ring_loss sp_event_take_loss(void);
