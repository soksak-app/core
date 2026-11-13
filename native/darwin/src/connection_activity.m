#import <Foundation/Foundation.h>
#include <os/lock.h>
#include "connection_activity.h"

static os_unfair_lock lock = OS_UNFAIR_LOCK_INIT;
// The token of the held activity, which this file retains, or nil.
static id<NSObject> activity;

void sp_connection_activity_hold(bool held) {
    os_unfair_lock_lock(&lock);
    if (held && activity == nil) {
        activity = [[NSProcessInfo.processInfo beginActivityWithOptions:NSActivityUserInitiatedAllowingIdleSystemSleep
            reason:@"a client of the endpoint is connected"] retain];
    } else if (!held && activity != nil) {
        [NSProcessInfo.processInfo endActivity:activity];
        [activity release];
        activity = nil;
    }
    os_unfair_lock_unlock(&lock);
}

bool sp_connection_activity_held(void) {
    os_unfair_lock_lock(&lock);
    bool held = activity != nil;
    os_unfair_lock_unlock(&lock);
    return held;
}
