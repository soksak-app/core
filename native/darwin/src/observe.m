// The one entrance of the native library for observers and delegates (observe.h).
#import "observe.h"
#import <os/lock.h>
#import <stdatomic.h>
#import <time.h>
#import "event_ring.h"

// One record for each source. The table has a fixed size, so a delivery never allocates; the records are never removed, so a pointer
// to one stays valid for the process.
enum { kMaxSources = 128, kNameBytes = 64 };

typedef struct {
    char name[kNameBytes];
    sp_observe_mode mode;
    _Atomic unsigned long long registrations;
    _Atomic unsigned long long total;
    _Atomic unsigned long long pending;
    _Atomic uint64_t lastSummary;
} source_record;

static source_record records[kMaxSources];
static size_t recordCount;
static os_unfair_lock tableLock = OS_UNFAIR_LOCK_INIT;

// At most one summary of a counted source is stored in this interval.
static const uint64_t summaryIntervalNs = 1000000000u;

static uint64_t monotonicNs(void) {
    return clock_gettime_nsec_np(CLOCK_MONOTONIC);
}

static bool validSource(const char *source) {
    if (!source) return false;
    size_t length = strlen(source);
    if (length == 0 || length >= kNameBytes) return false;
    for (size_t index = 0; index < length; index++) {
        char c = source[index];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-')) return false;
    }
    return true;
}

// Stores `native.observe.failed` with the JSON serializer of Foundation: the reason and the target are free text.
static void fail(const char *source, const char *kind, NSString *reason) {
    NSDictionary *fields = @{@"source": @(source ?: ""), @"kind": @(kind), @"reason": reason};
    NSData *json = [NSJSONSerialization dataWithJSONObject:fields options:0 error:NULL];
    NSCAssert(json != nil, @"the failure of a registration is serializable");
    NSString *text = [[[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] autorelease];
    sp_event(SP_CLASS_LIFECYCLE, SP_EVENT_ERROR, "native.observe.failed", text.UTF8String);
}

// The record of `source`, created by its first registration, or NULL after the event `native.observe.failed`. A source that a
// second registration names with another mode is refused, as its deliveries would be recorded in two ways.
static source_record *registerSource(const char *source, sp_observe_mode mode, const char *kind) {
    if (!validSource(source) || (mode != SP_OBSERVE_RECORD && mode != SP_OBSERVE_COUNT && mode != SP_OBSERVE_STORED)) {
        fail(source, kind, @"the source name is not 1 to 63 characters of a to z, 0 to 9 and ._-, or the mode is unknown");
        return NULL;
    }
    source_record *found = NULL;
    bool full = false;
    os_unfair_lock_lock(&tableLock);
    for (size_t index = 0; index < recordCount && !found; index++) {
        if (strcmp(records[index].name, source) == 0) found = &records[index];
    }
    if (!found && recordCount < kMaxSources) {
        found = &records[recordCount++];
        strlcpy(found->name, source, kNameBytes);
        found->mode = mode;
        atomic_store_explicit(&found->lastSummary, monotonicNs(), memory_order_relaxed);
    } else if (!found) {
        full = true;
    }
    os_unfair_lock_unlock(&tableLock);
    if (full) {
        fail(source, kind, @"the table of sources is full");
        return NULL;
    }
    if (found->mode != mode) {
        fail(source, kind, @"the source is registered with another mode");
        return NULL;
    }
    return found;
}

static source_record *lookup(const char *source) {
    source_record *found = NULL;
    os_unfair_lock_lock(&tableLock);
    for (size_t index = 0; index < recordCount && !found; index++) {
        if (strcmp(records[index].name, source) == 0) found = &records[index];
    }
    os_unfair_lock_unlock(&tableLock);
    return found;
}

static const char *modeName(sp_observe_mode mode) {
    return mode == SP_OBSERVE_COUNT ? "count" : mode == SP_OBSERVE_STORED ? "stored" : "record";
}

// Stores `native.observe.registered` and returns the record, or NULL after the failure event.
static source_record *recordRegistration(const char *source, sp_observe_mode mode, const char *kind, NSString *target) {
    source_record *record = registerSource(source, mode, kind);
    if (!record) return NULL;
    unsigned long long number = atomic_fetch_add_explicit(&record->registrations, 1, memory_order_relaxed) + 1;
    NSDictionary *fields = @{@"source": @(source), @"kind": @(kind), @"target": target ?: @"", @"mode": @(modeName(mode)), @"registrations": @(number)};
    NSData *json = [NSJSONSerialization dataWithJSONObject:fields options:0 error:NULL];
    NSCAssert(json != nil, @"the registration is serializable");
    NSString *text = [[[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] autorelease];
    sp_event(SP_CLASS_LIFECYCLE, SP_EVENT_INFO, "native.observe.registered", text.UTF8String);
    return record;
}

// Stores the summary of a counted source: the count since the earlier summary, the total and the microseconds between them.
static void summarize(source_record *record, uint64_t now, uint64_t before) {
    // A closed gate keeps the count in pending, so the first summary after the gate opens holds the deliveries since the earlier one.
    if (!sp_event_gate(SP_CLASS_FRAME, SP_EVENT_DEBUG)) return;
    unsigned long long count = atomic_exchange_explicit(&record->pending, 0, memory_order_relaxed);
    if (count == 0) return;
    char fields[192];
    snprintf(fields, sizeof fields, "{\"source\":\"%s\",\"count\":%llu,\"total\":%llu,\"micros\":%llu}", record->name, count,
        (unsigned long long)atomic_load_explicit(&record->total, memory_order_relaxed), before == 0 ? 0ull : (unsigned long long)((now - before) / 1000u));
    sp_event(SP_CLASS_FRAME, SP_EVENT_DEBUG, "native.observe.counted", fields);
}

static void deliver(source_record *record) {
    unsigned long long total = atomic_fetch_add_explicit(&record->total, 1, memory_order_relaxed) + 1;
    if (record->mode == SP_OBSERVE_STORED) return;
    if (record->mode == SP_OBSERVE_RECORD) {
        if (!sp_event_gate(SP_CLASS_INPUT, SP_EVENT_DEBUG)) return;
        char fields[128];
        snprintf(fields, sizeof fields, "{\"source\":\"%s\",\"count\":%llu}", record->name, total);
        sp_event(SP_CLASS_INPUT, SP_EVENT_DEBUG, "native.observe.delivered", fields);
        return;
    }
    atomic_fetch_add_explicit(&record->pending, 1, memory_order_relaxed);
    uint64_t now = monotonicNs();
    uint64_t last = atomic_load_explicit(&record->lastSummary, memory_order_relaxed);
    if (now - last >= summaryIntervalNs && atomic_compare_exchange_strong_explicit(&record->lastSummary, &last, now, memory_order_relaxed, memory_order_relaxed)) {
        summarize(record, now, last);
    }
}

void sp_observe_delivered(const char *source) {
    source_record *record = source ? lookup(source) : NULL;
    if (record) deliver(record);
    else fail(source, "delivered", @"the source is not registered");
}

unsigned long long sp_observe_count(const char *source) {
    source_record *record = source ? lookup(source) : NULL;
    return record ? atomic_load_explicit(&record->total, memory_order_relaxed) : 0;
}

void sp_observe_flush(void) {
    uint64_t now = monotonicNs();
    for (size_t index = 0; index < kMaxSources; index++) {
        source_record *record = NULL;
        os_unfair_lock_lock(&tableLock);
        if (index < recordCount) record = &records[index];
        os_unfair_lock_unlock(&tableLock);
        if (!record) return;
        if (record->mode != SP_OBSERVE_COUNT) continue;
        uint64_t last = atomic_exchange_explicit(&record->lastSummary, now, memory_order_relaxed);
        summarize(record, now, last);
    }
}

id sp_observe_notification(const char *source, sp_observe_mode mode, NSNotificationName name, id object, NSOperationQueue *queue,
    void (^handler)(NSNotification *)) {
    if (!handler) {
        fail(source, "notification", @"the handler is missing");
        return nil;
    }
    source_record *record = recordRegistration(source, mode, "notification", name);
    if (!record) return nil;
    return [NSNotificationCenter.defaultCenter addObserverForName:name object:object queue:queue usingBlock:^(NSNotification *note) {
        deliver(record);
        handler(note);
    }];
}

id sp_observe_workspace_notification(const char *source, sp_observe_mode mode, NSNotificationName name, void (^handler)(NSNotification *)) {
    if (!handler) {
        fail(source, "workspace_notification", @"the handler is missing");
        return nil;
    }
    source_record *record = recordRegistration(source, mode, "workspace_notification", name);
    if (!record) return nil;
    return [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification *note) {
        deliver(record);
        handler(note);
    }];
}

bool sp_observe_notification_selector(const char *source, sp_observe_mode mode, id observer, SEL selector, NSNotificationName name, id object) {
    if (!observer || !selector || ![observer respondsToSelector:selector]) {
        fail(source, "notification_selector", @"the observer or its selector is missing");
        return false;
    }
    if (!recordRegistration(source, mode, "notification_selector", name)) return false;
    [NSNotificationCenter.defaultCenter addObserver:observer selector:selector name:name object:object];
    return true;
}

bool sp_observe_key_path(const char *source, sp_observe_mode mode, id target, id observer, NSString *keyPath, NSKeyValueObservingOptions options,
    void *context) {
    if (!target || !observer || keyPath.length == 0) {
        fail(source, "key_path", @"the target, the observer or the key path is missing");
        return false;
    }
    NSString *description = [NSString stringWithFormat:@"%@.%@", NSStringFromClass([target class]), keyPath];
    if (!recordRegistration(source, mode, "key_path", description)) return false;
    [target addObserver:observer forKeyPath:keyPath options:options context:context];
    return true;
}

id sp_observe_local_monitor(const char *source, sp_observe_mode mode, NSEventMask mask, NSEvent *(^handler)(NSEvent *)) {
    if (!handler) {
        fail(source, "local_monitor", @"the handler is missing");
        return nil;
    }
    source_record *record = recordRegistration(source, mode, "local_monitor", [NSString stringWithFormat:@"mask 0x%llx", (unsigned long long)mask]);
    if (!record) return nil;
    id token = [NSEvent addLocalMonitorForEventsMatchingMask:mask handler:^NSEvent *(NSEvent *event) {
        deliver(record);
        return handler(event);
    }];
    if (!token) fail(source, "local_monitor", @"the system refused the monitor");
    return token;
}

id sp_observe_global_monitor(const char *source, sp_observe_mode mode, NSEventMask mask, void (^handler)(NSEvent *)) {
    if (!handler) {
        fail(source, "global_monitor", @"the handler is missing");
        return nil;
    }
    source_record *record = recordRegistration(source, mode, "global_monitor", [NSString stringWithFormat:@"mask 0x%llx", (unsigned long long)mask]);
    if (!record) return nil;
    id token = [NSEvent addGlobalMonitorForEventsMatchingMask:mask handler:^(NSEvent *event) {
        deliver(record);
        handler(event);
    }];
    if (!token) fail(source, "global_monitor", @"the system refused the monitor");
    return token;
}

dispatch_source_t sp_observe_process_exit(const char *source, sp_observe_mode mode, pid_t pid, dispatch_queue_t queue, void (^handler)(void)) {
    if (!handler) {
        fail(source, "process_exit", @"the handler is missing");
        return NULL;
    }
    source_record *record = recordRegistration(source, mode, "process_exit", [NSString stringWithFormat:@"pid %d", pid]);
    if (!record) return NULL;
    dispatch_source_t created = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, (uintptr_t)pid, DISPATCH_PROC_EXIT, queue);
    if (!created) {
        fail(source, "process_exit", @"the system refused the dispatch source");
        return NULL;
    }
    dispatch_source_set_event_handler(created, ^{
        deliver(record);
        handler();
    });
    return created;
}

CFRunLoopObserverRef sp_observe_run_loop(const char *source, sp_observe_mode mode, CFRunLoopRef loop, CFRunLoopActivity activities,
    bool repeats, CFIndex order, void (^handler)(void)) {
    if (!handler || !loop) {
        fail(source, "run_loop", @"the handler or the loop is missing");
        return NULL;
    }
    source_record *record = recordRegistration(source, mode, "run_loop", [NSString stringWithFormat:@"activities 0x%lx", (unsigned long)activities]);
    if (!record) return NULL;
    CFRunLoopObserverRef observer = CFRunLoopObserverCreateWithHandler(NULL, activities, repeats, order,
        ^(CFRunLoopObserverRef created, CFRunLoopActivity activity) {
            deliver(record);
            handler();
        });
    if (!observer) {
        fail(source, "run_loop", @"the system refused the run loop observer");
        return NULL;
    }
    CFRunLoopAddObserver(loop, observer, kCFRunLoopCommonModes);
    return observer;
}

bool sp_observe_apple_event(const char *source, sp_observe_mode mode, id handler, SEL selector, AEEventClass eventClass, AEEventID eventID) {
    NSCAssert(NSThread.isMainThread, @"an Apple event handler registration requires the main thread");
    if (!handler || !selector || ![handler respondsToSelector:selector]) {
        fail(source, "apple_event", @"the handler or its selector is missing");
        return false;
    }
    NSString *target = [NSString stringWithFormat:@"%c%c%c%c/%c%c%c%c", (int)(eventClass >> 24) & 0xff, (int)(eventClass >> 16) & 0xff,
        (int)(eventClass >> 8) & 0xff, (int)eventClass & 0xff, (int)(eventID >> 24) & 0xff, (int)(eventID >> 16) & 0xff,
        (int)(eventID >> 8) & 0xff, (int)eventID & 0xff];
    if (!recordRegistration(source, mode, "apple_event", target)) return false;
    [[NSAppleEventManager sharedAppleEventManager] setEventHandler:handler andSelector:selector forEventClass:eventClass andEventID:eventID];
    return true;
}

bool sp_observe_delegate(const char *source, sp_observe_mode mode, id owner, id delegate) {
    if (!owner || ![owner respondsToSelector:@selector(setDelegate:)]) {
        fail(source, "delegate", @"the owner has no delegate property");
        return false;
    }
    if (!recordRegistration(source, mode, "delegate", NSStringFromClass([owner class]))) return false;
    [owner performSelector:@selector(setDelegate:) withObject:delegate];
    return true;
}
