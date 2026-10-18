// Checks the memory pressure owner of the process (docs/spec/hosts.md#memory-pressure): one start registers exactly one
// memory pressure source through the entrance, which observes normal, warn and critical; a second start registers nothing; each
// change of level reaches the report block with its level and the next seq and is the event native.memory.pressure; a report of
// the level in force is not a change. The reports come from the declared fault injection, which delivers a level as the source
// does. The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import "memory_pressure.h"
#import "support/records.h"
#import "event_ring.h"

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

int main(void) { @autoreleasepool {
    const int8_t allLevels[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(allLevels), @"the policy stores every level of every class");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    check(!sp_memory_pressure_inject("warn"), @"an injection before the start is refused");

    NSMutableArray<NSString *> *reports = [NSMutableArray array];
    __block bool started = false;
    NSArray<NSDictionary *> *registered = capturedEvents(^{
        started = sp_memory_pressure_start(^(const char *level, unsigned long long seq) {
            [reports addObject:[NSString stringWithFormat:@"%s %llu", level, seq]];
        });
    });
    check(started, @"the first start succeeds");
    NSArray<NSDictionary *> *registrations = named(registered, @"native.observe.registered");
    NSDictionary *registration = registrations.count == 1 ? registrations[0][@"fields"] : @{};
    check(registrations.count == 1 && [registration[@"kind"] isEqual:@"memory_pressure"]
        && [registration[@"target"] isEqual:@"normal, warn and critical"] && [registration[@"registrations"] intValue] == 1,
        [NSString stringWithFormat:@"the start registers exactly one source of normal, warn and critical: %@", registrations]);

    __block bool again = true;
    NSArray<NSDictionary *> *second = capturedEvents(^{ again = sp_memory_pressure_start(^(const char *level, unsigned long long seq) {}); });
    check(!again && named(second, @"native.observe.registered").count == 0, @"a second start is refused and registers nothing");

    NSArray<NSDictionary *> *delivered = capturedEvents(^{
        check(sp_memory_pressure_inject("normal"), @"an injection of normal is accepted");
        check(sp_memory_pressure_inject("warn"), @"an injection of warn is accepted");
        check(sp_memory_pressure_inject("warn"), @"a second injection of warn is accepted");
        check(sp_memory_pressure_inject("critical"), @"an injection of critical is accepted");
        check(sp_memory_pressure_inject("normal"), @"an injection of normal after critical is accepted");
    });
    NSArray<NSString *> *expected = @[ @"warn 1", @"critical 2", @"normal 3" ];
    check([reports isEqualToArray:expected], [NSString stringWithFormat:
        @"each change of level reaches the report with its level and seq, and a level in force is no report (%@)", reports]);
    NSMutableArray<NSString *> *events = [NSMutableArray array];
    for (NSDictionary *event in named(delivered, @"native.memory.pressure")) {
        check([event[@"class"] intValue] == SP_CLASS_LIFECYCLE && [event[@"level"] intValue] == SP_EVENT_INFO,
            @"a report is stored in the lifecycle class at info");
        [events addObject:[NSString stringWithFormat:@"%@ %@", event[@"fields"][@"level"], event[@"fields"][@"seq"]]];
    }
    check([events isEqualToArray:expected], [NSString stringWithFormat:@"each report is the event native.memory.pressure (%@)", events]);

    check(!sp_memory_pressure_inject("severe") && !sp_memory_pressure_inject(NULL), @"an unknown level is refused");
    check(reports.count == 3, @"a refused injection reports nothing");

    printf("%s\n", failures ? "FAIL: memory_pressure_test" : "PASS: memory_pressure_test");
    return failures ? 1 : 0;
}}
