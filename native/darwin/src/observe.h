// The one entrance of the native library for every observer, monitor, key-value observer, run loop observer, dispatch source, Apple
// event handler and delegate (docs/spec/logging.md#automatic-entrances). A registration is made only through these functions:
// each records the registration as the event `native.observe.registered` (or `native.observe.failed` at the level error when the
// platform refuses it) and counts every delivery by the name of its source, so a new registration is covered without a record at its
// call site. `make census-check` rejects the registration API outside observe.m.
//
// A `source` names one kind of registration (1 to 63 characters of a to z, 0 to 9 and `._-`); all registrations of a source
// share its counts. The delivery of a block is recorded by the block this entrance installs; a selector, a key-value observer, an
// Apple event handler and a delegate call sp_observe_delivered(source) first in the method that receives the delivery.
//
// A delivery is recorded in one of three modes:
//   SP_OBSERVE_RECORD  each delivery is the event `native.observe.delivered` {source, count} at the level debug, in order, with the
//                      real time of the delivery. It is for deliveries at the speed of a person or slower.
//   SP_OBSERVE_COUNT   each delivery increments an exact count. At most once per second a delivery stores the event
//                      `native.observe.counted` {source, count, total, micros} with the count since the earlier summary, so no
//                      delivery is lost from the count and a delivery at the speed of a frame costs one atomic add and no allocation.
//                      The first summary comes one interval after the first registration of the source. The count after the last
//                      summary is stored by sp_observe_flush and is readable with sp_observe_count.
//   SP_OBSERVE_STORED  the receiver stores an event of its own for each occurrence, so the entrance only counts (sp_observe_count). It
//                      is for a delivery whose event carries more than the delivery.
//
// No function of this header allocates for a delivery. Every function runs on any thread unless a platform call says otherwise.
#pragma once

#import <Cocoa/Cocoa.h>
#include <stdbool.h>

typedef enum { SP_OBSERVE_RECORD = 0, SP_OBSERVE_COUNT = 1, SP_OBSERVE_STORED = 2 } sp_observe_mode;

// Registers a block for a notification. Returns the token of the center (remove it with removeObserver:), or nil, after the
// event `native.observe.failed`, when the handler is missing.
id sp_observe_notification(const char *source, sp_observe_mode mode, NSNotificationName name, id object, NSOperationQueue *queue,
    void (^handler)(NSNotification *));

// Registers the selector of an observer for a notification. The selector calls sp_observe_delivered(source). Returns false after
// the event `native.observe.failed` when the observer or the selector is missing.
bool sp_observe_notification_selector(const char *source, sp_observe_mode mode, id observer, SEL selector, NSNotificationName name, id object);

// Registers `observer` for the key path of `target` with `context`. observeValueForKeyPath calls sp_observe_delivered(source). Returns
// false after the event `native.observe.failed` when an argument is missing. An observer that is a view of the platform receives the
// notifications that the platform registers on it too, so its observeValueForKeyPath compares `context` with the one it registered
// and passes every other notification to its superclass.
bool sp_observe_key_path(const char *source, sp_observe_mode mode, id target, id observer, NSString *keyPath, NSKeyValueObservingOptions options,
    void *context);

// Registers a monitor of the events delivered to this application (local) or to other applications (global), and returns its token, or
// nil, after the event `native.observe.failed`, when the platform or a missing handler refuses it. Main thread only.
id sp_observe_local_monitor(const char *source, sp_observe_mode mode, NSEventMask mask, NSEvent *(^handler)(NSEvent *));
id sp_observe_global_monitor(const char *source, sp_observe_mode mode, NSEventMask mask, void (^handler)(NSEvent *));

// Creates the dispatch source that reports the exit of `pid` on `queue`. The caller sets its cancel handler and resumes it. Returns
// NULL, after the event `native.observe.failed`, when the system refuses it or the handler is missing.
dispatch_source_t sp_observe_process_exit(const char *source, sp_observe_mode mode, pid_t pid, dispatch_queue_t queue, void (^handler)(void));

// Adds a run loop observer of `activities` in the common modes of the loop. Returns the observer, or NULL, after the event
// `native.observe.failed`, when the system refuses it or the handler is missing.
CFRunLoopObserverRef sp_observe_run_loop(const char *source, sp_observe_mode mode, CFRunLoopRef loop, CFRunLoopActivity activities,
    bool repeats, CFIndex order, void (^handler)(void));

// Installs `handler` for the Apple event of the class and the id. The selector calls sp_observe_delivered(source). Returns false after
// the event `native.observe.failed` when an argument is missing. Main thread only.
bool sp_observe_apple_event(const char *source, sp_observe_mode mode, id handler, SEL selector, AEEventClass eventClass, AEEventID eventID);

// Sets the delegate of `owner` (an object with a `delegate` property). A method of the delegate calls sp_observe_delivered(source).
// Returns false after the event `native.observe.failed` when the owner has no delegate property.
bool sp_observe_delegate(const char *source, sp_observe_mode mode, id owner, id delegate);

// Counts one delivery of `source` and stores its record by the mode of the source.
void sp_observe_delivered(const char *source);

// The exact number of deliveries of `source` since the process started, or 0 for a source that was never registered.
unsigned long long sp_observe_count(const char *source);

// Stores the summary of every source of the mode SP_OBSERVE_COUNT that has deliveries after its last summary.
void sp_observe_flush(void);
