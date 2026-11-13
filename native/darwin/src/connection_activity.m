#import <Foundation/Foundation.h>
#include <os/lock.h>
#include "connection_activity.h"
#include "event_ring.h"

static os_unfair_lock lock = OS_UNFAIR_LOCK_INIT;
// The token of the held activity, which this file retains, or nil.
static id<NSObject> activity;

void sp_connection_activity_hold(bool held) {
    os_unfair_lock_lock(&lock);
    if (held && activity == nil) {
        activity = [[NSProcessInfo.processInfo beginActivityWithOptions:NSActivityUserInitiatedAllowingIdleSystemSleep
            reason:@"a client of the endpoint is connected"] retain];
        // The record follows the change under the lock, so the records of the changes keep their order.
        sp_event(SP_CLASS_LIFECYCLE, SP_EVENT_INFO, "native.connection.activity", "{\"held\":true}");
    } else if (!held && activity != nil) {
        [NSProcessInfo.processInfo endActivity:activity];
        [activity release];
        activity = nil;
        sp_event(SP_CLASS_LIFECYCLE, SP_EVENT_INFO, "native.connection.activity", "{\"held\":false}");
    }
    os_unfair_lock_unlock(&lock);
}

bool sp_connection_activity_held(void) {
    os_unfair_lock_lock(&lock);
    bool held = activity != nil;
    os_unfair_lock_unlock(&lock);
    return held;
}
