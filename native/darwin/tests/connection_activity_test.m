// The activity that the host holds while a connection of its endpoint is open (docs/spec/endpoint.md#transport): a hold begins
// one activity, a repeated hold keeps it, and a release ends it, so the endpoint passes its state on each change of the
// connections without counting calls. Each begin and each end of the activity leaves one record, and a hold or a release that
// changes nothing leaves none.
#import <Foundation/Foundation.h>
#include "connection_activity.h"
#import "event_ring.h"
#include "support/records.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

int main(void) {
    @autoreleasepool {
        check(!sp_connection_activity_held(), @"no activity is held before the first connection");
        sp_connection_activity_hold(true);
        check(sp_connection_activity_held(), @"the hold begins the activity");
        sp_connection_activity_hold(true);
        check(sp_connection_activity_held(), @"a repeated hold keeps the activity");
        sp_connection_activity_hold(false);
        check(!sp_connection_activity_held(), @"the release ends the activity");
        sp_connection_activity_hold(false);
        check(!sp_connection_activity_held(), @"a repeated release changes nothing");
        sp_connection_activity_hold(true);
        check(sp_connection_activity_held(), @"a hold after the release begins the activity again");
        sp_connection_activity_hold(false);
        // The record of the activity is a lifecycle event at info, which the default policy refuses (docs/spec/logging.md#policy).
        const int8_t everything[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
        check(sp_event_set_policy(everything), @"the policy stores every level of every class");
        NSArray<NSDictionary *> *events = capturedEvents(^{
            sp_connection_activity_hold(true);
            sp_connection_activity_hold(true);
            sp_connection_activity_hold(false);
            sp_connection_activity_hold(false);
        });
        NSMutableArray<NSString *> *changes = [NSMutableArray array];
        for (NSDictionary *event in events) {
            if (![event[@"name"] isEqual:@"native.connection.activity"]) continue;
            [changes addObject:[event[@"fields"][@"held"] boolValue] ? @"held" : @"released"];
        }
        check([changes isEqual:@[@"held", @"released"]],
            [NSString stringWithFormat:@"the begin and the end of the activity leave one record each, and the repeated calls none: %@",
                changes]);
    }
    return failures == 0 ? 0 : 1;
}
