// Every registration made through the entrance is recorded, every delivery is counted exactly, and a refused registration is an
// event of the level error (docs/spec/logging.md#automatic-entrances). The check posts notifications and changes properties itself;
// it does not activate the application.
#import <Cocoa/Cocoa.h>
#import "observe.h"
#import "support/records.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static NSArray<NSDictionary *> *named(NSArray<NSDictionary *> *events, NSString *name) {
    return [events filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSDictionary *event, id bindings) {
        return [event[@"name"] isEqual:name];
    }]];
}

static NSNotificationName const probe = @"ObserveTestProbe";

// A target of the selector and key-value registrations.
@interface Probe : NSObject
@property(nonatomic, assign) int value;
@property(nonatomic, assign) id delegate;
@property(nonatomic, assign) int selectorCalls;
@property(nonatomic, assign) int keyPathCalls;
- (void)notified:(NSNotification *)note;
@end

@implementation Probe
- (void)notified:(NSNotification *)note {
    sp_observe_delivered("test.selector");
    self.selectorCalls++;
}
- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
    sp_observe_delivered("test.key_path");
    self.keyPathCalls++;
}
@end

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;

    // A registration by block is recorded, and each delivery is an event with its exact count.
    __block int calls = 0;
    NSArray<NSDictionary *> *registered = capturedEvents(^{
        id token = sp_observe_notification("test.block", SP_OBSERVE_RECORD, probe, nil, nil, ^(NSNotification *note) { calls++; });
        check(token != nil, @"a block registration returns the token of the center");
    });
    NSArray *registrations = named(registered, @"native.observe.registered");
    NSDictionary *registration = registrations.count == 1 ? registrations[0][@"fields"] : @{};
    check(registrations.count == 1 && [registrations[0][@"level"] intValue] == 2, @"the registration is one event at the level info");
    check([registration[@"source"] isEqual:@"test.block"] && [registration[@"kind"] isEqual:@"notification"]
        && [registration[@"target"] isEqual:probe] && [registration[@"mode"] isEqual:@"record"] && [registration[@"registrations"] intValue] == 1,
        [NSString stringWithFormat:@"the registration names the source, the kind, the target, the mode and its number: %@", registration]);
    NSArray<NSDictionary *> *delivered = capturedEvents(^{
        [center postNotificationName:probe object:nil];
        [center postNotificationName:probe object:nil];
    });
    NSArray *deliveries = named(delivered, @"native.observe.delivered");
    check(calls == 2 && deliveries.count == 2 && [deliveries[0][@"fields"][@"count"] intValue] == 1
        && [deliveries[1][@"fields"][@"count"] intValue] == 2 && [deliveries[0][@"level"] intValue] == 3,
        [NSString stringWithFormat:@"each of two deliveries runs the handler and is one event at the level debug with its count: %@", deliveries]);

    // The same source registered again is counted as its second registration and shares the count.
    NSArray<NSDictionary *> *again = capturedEvents(^{
        sp_observe_notification("test.block", SP_OBSERVE_RECORD, @"ObserveTestOther", nil, nil, ^(NSNotification *note) {});
    });
    check(named(again, @"native.observe.registered").count == 1 && [named(again, @"native.observe.registered")[0][@"fields"][@"registrations"] intValue] == 2,
        @"a second registration of a source is number 2");

    // A delivery in the mode of counting keeps the exact count, and its summaries add up to it.
    __block int fast = 0;
    sp_observe_notification("test.counted", SP_OBSERVE_COUNT, @"ObserveTestFast", nil, nil, ^(NSNotification *note) { fast++; });
    NSArray<NSDictionary *> *counted = capturedEvents(^{
        for (int index = 0; index < 5000; index++) [center postNotificationName:@"ObserveTestFast" object:nil];
        sp_observe_flush();
    });
    NSArray *summaries = named(counted, @"native.observe.counted");
    long sum = 0;
    for (NSDictionary *summary in summaries) sum += [summary[@"fields"][@"count"] longValue];
    check(fast == 5000 && sp_observe_count("test.counted") == 5000, @"5000 deliveries run the handler 5000 times and are counted exactly");
    check(sum == 5000 && summaries.count >= 1 && summaries.count < 50 && [summaries.lastObject[@"fields"][@"total"] longValue] == 5000,
        [NSString stringWithFormat:@"%lu summaries add up to 5000 and the last holds the total", (unsigned long)summaries.count]);
    check(named(counted, @"native.observe.delivered").count == 0, @"a counted source stores no event for each delivery");
    check([summaries[0][@"level"] intValue] == 3, @"a summary is at the level debug");

    // A selector and a key path count their deliveries through sp_observe_delivered.
    Probe *target = [[Probe alloc] init];
    NSArray<NSDictionary *> *selector = capturedEvents(^{
        check(sp_observe_notification_selector("test.selector", SP_OBSERVE_RECORD, target, @selector(notified:), probe, nil), @"a selector registration succeeds");
        [center postNotificationName:probe object:nil];
    });
    check(target.selectorCalls == 1 && named(selector, @"native.observe.registered").count == 1
        && [named(selector, @"native.observe.registered")[0][@"fields"][@"kind"] isEqual:@"notification_selector"]
        && named(selector, @"native.observe.delivered").count == 2, @"a selector is registered and its delivery is an event");
    NSArray<NSDictionary *> *keyPath = capturedEvents(^{
        check(sp_observe_key_path("test.key_path", SP_OBSERVE_RECORD, target, target, @"value", 0), @"a key path registration succeeds");
        target.value = 3;
        [target removeObserver:target forKeyPath:@"value"];
    });
    NSArray *keyed = named(keyPath, @"native.observe.delivered");
    check(target.keyPathCalls == 1 && keyed.count == 1 && [keyed[0][@"fields"][@"source"] isEqual:@"test.key_path"]
        && [named(keyPath, @"native.observe.registered")[0][@"fields"][@"target"] isEqual:@"Probe.value"],
        @"a key path is registered with its class and key, and its change is one delivery");

    // A monitor is registered and a delivery of its events is recorded.
    NSArray<NSDictionary *> *monitor = capturedEvents(^{
        id token = sp_observe_local_monitor("test.monitor", SP_OBSERVE_RECORD, NSEventMaskApplicationDefined, ^NSEvent *(NSEvent *event) { return event; });
        check(token != nil, @"a local monitor returns its token");
        NSEvent *event = [NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0
            timestamp:0 windowNumber:0 context:nil subtype:1 data1:0 data2:0];
        [NSApp sendEvent:event];
        [NSEvent removeMonitor:token];
    });
    check(named(monitor, @"native.observe.registered").count == 1 && [named(monitor, @"native.observe.registered")[0][@"fields"][@"kind"] isEqual:@"local_monitor"]
        && named(monitor, @"native.observe.delivered").count == 1, @"a local monitor is registered and the event it receives is one delivery");

    // A run loop observer and a dispatch source are registered through the entrance too.
    __block int loops = 0;
    NSArray<NSDictionary *> *loop = capturedEvents(^{
        CFRunLoopObserverRef observer = sp_observe_run_loop("test.run_loop", SP_OBSERVE_COUNT, CFRunLoopGetMain(), kCFRunLoopBeforeWaiting, true, 0, ^{ loops++; });
        check(observer != NULL, @"a run loop observer is returned");
        [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
        CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, kCFRunLoopCommonModes);
        CFRelease(observer);
    });
    check(loops >= 1 && sp_observe_count("test.run_loop") == (unsigned long long)loops && [named(loop, @"native.observe.registered")[0][@"fields"][@"kind"] isEqual:@"run_loop"],
        [NSString stringWithFormat:@"the run loop observer is registered and its %d deliveries are counted exactly", loops]);
    __block dispatch_source_t exit = NULL;
    NSArray<NSDictionary *> *process = capturedEvents(^{
        exit = sp_observe_process_exit("test.process_exit", SP_OBSERVE_RECORD, getpid(), dispatch_get_main_queue(), ^{});
    });
    check(exit != NULL && named(process, @"native.observe.registered").count == 1
        && [named(process, @"native.observe.registered")[0][@"fields"][@"kind"] isEqual:@"process_exit"], @"a process exit source is registered");
    if (exit) { dispatch_source_set_cancel_handler(exit, ^{}); dispatch_resume(exit); dispatch_source_cancel(exit); }

    // A source whose receiver stores its own event is only counted: the entrance stores the registration and no delivery.
    __block int stored = 0;
    NSArray<NSDictionary *> *everything = capturedEvents(^{
        sp_observe_notification("test.stored", SP_OBSERVE_STORED, @"ObserveTestStored", nil, nil, ^(NSNotification *note) { stored++; });
        [center postNotificationName:@"ObserveTestStored" object:nil];
        [center postNotificationName:@"ObserveTestStored" object:nil];
        sp_observe_flush();
    });
    NSArray *own = [everything filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"fields.source == 'test.stored'"]];
    check(stored == 2 && sp_observe_count("test.stored") == 2 && own.count == 1 && [own[0][@"fields"][@"mode"] isEqual:@"stored"],
        [NSString stringWithFormat:@"a stored source counts two deliveries exactly and stores only its registration: %@", own]);

    // A delegate is set through the entrance; an owner without a delegate property is refused with an error event.
    Probe *owner = [[Probe alloc] init];
    NSArray<NSDictionary *> *delegate = capturedEvents(^{
        check(sp_observe_delegate("test.delegate", SP_OBSERVE_RECORD, owner, target), @"a delegate is set");
    });
    check(owner.delegate == target && [named(delegate, @"native.observe.registered")[0][@"fields"][@"kind"] isEqual:@"delegate"], @"the delegate is the object that was given, and the registration is an event");

    // A refused registration is an error event; no registration stays silent.
    NSArray<NSDictionary *> *refused = capturedEvents(^{
        check(sp_observe_notification("test.refused", SP_OBSERVE_RECORD, probe, nil, nil, nil) == nil, @"a registration without a handler returns nil");
        check(!sp_observe_delegate("test.refused", SP_OBSERVE_RECORD, [[NSObject alloc] init], target), @"an owner without a delegate property refuses the delegate");
        check(!sp_observe_key_path("test.refused", SP_OBSERVE_RECORD, nil, target, @"value", 0), @"a missing target refuses the key path");
    });
    NSArray *failed = named(refused, @"native.observe.failed");
    check(failed.count == 3 && [failed[0][@"level"] intValue] == 0 && [failed[0][@"fields"][@"source"] isEqual:@"test.refused"]
        && [failed[0][@"fields"][@"reason"] length] > 0 && named(refused, @"native.observe.registered").count == 0,
        [NSString stringWithFormat:@"three refused registrations are three events at the level error with a reason and no registration: %@", failed]);

    return failures == 0 ? 0 : 1;
} }
