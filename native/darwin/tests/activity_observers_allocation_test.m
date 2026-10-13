// The records of the native library allocate no memory that they keep, and the update of a window whose first responder did not
// change allocates nothing (docs/spec/logging.md#automatic-entrances). The sources are compiled with manual reference counting, so
// the check counts the allocations of the measuring thread through the malloc logger: an allocation that is not freed by the end
// of a run is a leak, and the allocations of an update with an unchanged first responder are compared with the allocations of the
// same notification delivered to no observer. The observers and the records run on the thread that posts the notifications; other
// threads of the process are not counted, because the text input analytics of the system allocate on a queue of their own after a
// text view becomes the first responder, at a moment that the check does not control.
#import <Cocoa/Cocoa.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#import "activity_observers.h"
#import "application_log.h"
#import "support/records.h"

typedef void(malloc_logger_t)(uint32_t type, uintptr_t arg1, uintptr_t arg2, uintptr_t arg3, uintptr_t result, uint32_t skip);
extern malloc_logger_t *malloc_logger;

static const uint32_t typeAllocate = 2;
static const uint32_t typeDeallocate = 4;
static atomic_long allocations = 0;
static atomic_long deallocations = 0;
static pthread_t measured;

static void logger(uint32_t type, uintptr_t arg1, uintptr_t arg2, uintptr_t arg3, uintptr_t result, uint32_t skip) {
    if (!pthread_equal(pthread_self(), measured)) return;
    if (type & typeAllocate) atomic_fetch_add(&allocations, 1);
    if (type & typeDeallocate) atomic_fetch_add(&deallocations, 1);
}

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

/// Runs block with the malloc logger installed and returns the allocations of the measuring thread and the blocks still held at its end.
static void counted(void (^block)(void), long *made, long *held) {
    long beforeMade = atomic_load(&allocations);
    long beforeFreed = atomic_load(&deallocations);
    malloc_logger = logger;
    block();
    malloc_logger = NULL;
    *made = atomic_load(&allocations) - beforeMade;
    *held = *made - (atomic_load(&deallocations) - beforeFreed);
}

int main(void) { @autoreleasepool {
    measured = pthread_self();
    [NSApplication sharedApplication];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 200, 100)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    NSTextView *field = [[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 100, 50)];
    [window.contentView addSubview:field];
    [window makeFirstResponder:field];
    sp_observe_activity();
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    const int rounds = 2000;

    // An update with an unchanged first responder: the first update stores the state, the later ones compare it.
    [center postNotificationName:NSWindowDidUpdateNotification object:window];
    long updateMade = 0, updateHeld = 0, baseMade = 0, baseHeld = 0;
    counted(^{
        for (int index = 0; index < rounds; index++) @autoreleasepool { [center postNotificationName:NSWindowDidUpdateNotification object:window]; }
    }, &updateMade, &updateHeld);
    counted(^{
        for (int index = 0; index < rounds; index++) @autoreleasepool { [center postNotificationName:@"ActivityAllocationUnobserved" object:window]; }
    }, &baseMade, &baseHeld);
    // The observer counts its deliveries and stores one summary event in each second; that summary is the only allocation allowed.
    check(updateMade - baseMade <= rounds / 10, [NSString stringWithFormat:@"%d updates with an unchanged first responder allocate %ld blocks more than the same notifications without an observer (%ld against %ld)",
        rounds, updateMade - baseMade, updateMade, baseMade]);

    // A record of the activity and a record of the log keep nothing: the ring is emptied before each run, so a stored event is
    // freed with its bytes.
    long made = 0, held = 0;
    counted(^{
        @autoreleasepool { capturedEvents(^{
            for (int index = 0; index < rounds; index++) @autoreleasepool { [center postNotificationName:NSWindowDidBecomeKeyNotification object:window]; }
        }); }
    }, &made, &held);
    check(held < rounds / 10, [NSString stringWithFormat:@"%d activity events hold %ld blocks at the end (%ld allocated)", rounds, held, made]);
    counted(^{
        @autoreleasepool { capturedEvents(^{
            for (int index = 0; index < rounds; index++) @autoreleasepool { sp_log_info("allocation test", "a record"); }
        }); }
    }, &made, &held);
    check(held < rounds / 10, [NSString stringWithFormat:@"%d log records hold %ld blocks at the end (%ld allocated)", rounds, held, made]);
    return failures == 0 ? 0 : 1;
} }
