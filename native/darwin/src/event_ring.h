// A bounded lock-free ring for many producer threads and one consumer (docs/spec/logging.md#writers). A producer copies
// a variable-length event into the ring without a lock, an allocation or a system call; a full ring returns false and
// counts the loss. The consumer drains whole events into a buffer.

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct sp_event_ring sp_event_ring;

// The channels of the files that store the events (docs/spec/logging.md#files): `other` holds the levels error, warn and info,
// `debug` holds debug and trace. The ring counts what it refuses for each channel.
enum { SP_EVENT_CHANNEL_OTHER = 0, SP_EVENT_CHANNEL_DEBUG = 1, SP_EVENT_CHANNELS = 2 };

// The events and bytes that a full ring refused in a channel since the loss was last taken.
typedef struct {
    uint64_t events;
    uint64_t bytes;
} sp_event_ring_loss;

// Creates a ring that holds at least `capacity` bytes (rounded up to a power of two, at least 64). Returns NULL when the
// memory cannot be allocated.
sp_event_ring *sp_event_ring_create(size_t capacity);
void sp_event_ring_destroy(sp_event_ring *ring);

// Copies `length` bytes into the ring as one event of a channel. Returns false, and counts the loss in the channel, when the
// ring has no room or the event can never fit; a channel outside the enumeration is refused and counted in the channel other.
// Safe from any thread.
bool sp_event_ring_push(sp_event_ring *ring, uint8_t channel, const void *bytes, size_t length);

// Moves whole events into `buffer` (at most `capacity` bytes) and returns the number of bytes written. Each event is a
// 4-byte length in host byte order and its bytes. Returns 0 when the ring is empty or when the next event does not fit
// in the buffer. Only one thread drains.
size_t sp_event_ring_drain(sp_event_ring *ring, uint8_t *buffer, size_t capacity);

// Returns the loss of a channel counted since the last call and resets it. A channel outside the enumeration has no loss.
sp_event_ring_loss sp_event_ring_take_loss(sp_event_ring *ring, uint8_t channel);

// The ring of this process (docs/spec/logging.md#writers). It is created on the first call, so an event produced before
// the writer of the host exists waits in it. Every thread of the process may call sp_event; the writer of the host drains.
enum { SP_EVENT_ERROR = 0, SP_EVENT_WARN = 1, SP_EVENT_INFO = 2, SP_EVENT_DEBUG = 3, SP_EVENT_TRACE = 4 };

// The class of an event, in the order of the contract (docs/spec/logging.md#classes-and-policy). The producer gives the class that
// the catalog declares for the event, and the record carries it to the line of the file.
enum { SP_CLASS_LIFECYCLE = 0, SP_CLASS_INPUT = 1, SP_CLASS_CALL = 2, SP_CLASS_IO = 3, SP_CLASS_FRAME = 4, SP_CLASS_COUNT = 5 };

// The monotonic clock of the records in nanoseconds: `clock_gettime_nsec_np(CLOCK_UPTIME_RAW)`, which is mach_absolute_time
// converted to nanoseconds. It is comparable across the processes of one boot, does not step, and does not advance while
// the machine sleeps.
uint64_t sp_mono_ns(void);

// Stores an event: the wall clock in microseconds, the monotonic clock, the class, the level, the name (1 to 255 bytes) and the
// fields as JSON text. It copies the arguments, does not wait, and returns false, and counts the loss in the channel of the
// level, for a missing or empty or too long name, a level or a class outside the enumeration, missing fields, a full ring, or an
// event that can never fit.
bool sp_event(uint8_t eventClass, uint8_t level, const char *name, const char *fields_json);

// Stores an event like sp_event, with the correlation identifiers of the inputs it belongs to: `cids` is a list of
// identifiers separated by ',' (an empty list for none). A missing list, a list over 65535 bytes, and a list with a '"', a
// '\\' or a control character are refused and counted like a refused name.
bool sp_event_cids(uint8_t eventClass, uint8_t level, const char *name, const char *cids, const char *fields_json);

// Sets the policy of the process: for each class, in the order of SP_CLASS_*, the least severe level that is stored (a number of
// SP_EVENT_*) or -1 for none. Returns false, and keeps the policy in force, for a missing array or a value outside -1 to
// SP_EVENT_TRACE. Before the first call every level of every class is stored. The host sets it from the policy file.
bool sp_event_set_policy(const int8_t *levels);

// Whether an event of the class and the level is stored under the policy. It counts nothing. A class or a level outside the
// enumeration answers true, because sp_event refuses and counts it.
bool sp_event_enabled(uint8_t eventClass, uint8_t level);

// The question of a producer before it builds the fields of an event: like sp_event_enabled, and a closed gate counts the event
// that the producer then does not build. sp_event asks it too. The drain reports each count as the event `native.log.gated`
// (`class`, `level`, `count`) of the class lifecycle at the level info, which passes every gate.
bool sp_event_gate(uint8_t eventClass, uint8_t level);

// Sets the boot identifier of the run, which the host chose for its event files: letters, digits, '-' and '_' (at most 64
// bytes). The correlation identifiers of this process are `<boot>.<n>`. Returns false, and keeps the earlier identifier, for
// a missing, empty or longer identifier or one with another character.
bool sp_event_set_boot(const char *boot);

// Writes the next correlation identifier `<boot>.<n>` (n counts from 1 in this process) as a string to `buffer` and returns
// true. Returns false, and writes nothing, when the boot identifier is not set or the buffer is too small. Safe from any
// thread.
bool sp_cid_new(char *buffer, size_t capacity);

// Moves whole records of the process ring into `buffer`, as sp_event_drain does. A record is, in host byte order, the wall
// clock in microseconds (8 bytes), the monotonic clock in nanoseconds (8), the level (1), the class (1), the length of the name
// (1), the length of the cids (2), the name, the cids (the list of sp_event_cids) and the fields.
enum { SP_EVENT_HEADER_BYTES = 21 };
size_t sp_event_drain(uint8_t *buffer, size_t capacity);

// Returns the loss of a channel of the process ring since the last call and resets it.
sp_event_ring_loss sp_event_take_loss(uint8_t channel);
