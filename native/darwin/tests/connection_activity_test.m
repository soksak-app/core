// The activity that the host holds while a connection of its endpoint is open (docs/spec/endpoint.md#transport): a hold begins
// one activity, a repeated hold keeps it, and a release ends it, so the endpoint passes its state on each change of the
// connections without counting calls.
#import <Foundation/Foundation.h>
#include "connection_activity.h"

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
    }
    return failures == 0 ? 0 : 1;
}
