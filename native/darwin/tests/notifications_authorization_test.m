// Checks the classification of a completed authorization request of the system notification module
// (docs/spec/plugins.md#tab-reports). The notification center answers a refused authorization with the error
// UNErrorCodeNotificationsNotAllowed, and a refusal is reported only through the authorization of the state event. The check
// calls the classification with the values that the notification center passes; it does not open the notification center.
#import <Cocoa/Cocoa.h>
#import <UserNotifications/UserNotifications.h>
#import "notifications.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static NSString *outcomeName(sp_notifications_request_outcome outcome) {
    switch (outcome) {
        case SP_NOTIFICATIONS_REQUEST_POST: return @"post";
        case SP_NOTIFICATIONS_REQUEST_REPORT: return @"report";
        case SP_NOTIFICATIONS_REQUEST_FAILED: return @"failed";
    }
    return [NSString stringWithFormat:@"unknown %d", (int)outcome];
}

static void expect(bool granted, NSError *error, UNAuthorizationStatus authorization, sp_notifications_request_outcome expected,
    NSString *message) {
    sp_notifications_request_outcome outcome = sp_notifications_request_classify(granted, error, authorization);
    check(outcome == expected, [NSString stringWithFormat:@"%@ (expected %@, got %@)", message, outcomeName(expected), outcomeName(outcome)]);
}

int main(void) { @autoreleasepool {
    NSError *notAllowed = [NSError errorWithDomain:UNErrorDomain code:UNErrorCodeNotificationsNotAllowed
        userInfo:@{NSLocalizedDescriptionKey: @"Notifications are not allowed for this application"}];
    expect(false, notAllowed, UNAuthorizationStatusDenied, SP_NOTIFICATIONS_REQUEST_REPORT,
        @"a refused authorization reports the denied state without a failure");
    expect(false, notAllowed, UNAuthorizationStatusNotDetermined, SP_NOTIFICATIONS_REQUEST_FAILED,
        @"a refusal that leaves the authorization undetermined is reported as a failure");
    expect(false, [NSError errorWithDomain:UNErrorDomain code:UNErrorCodeNotificationInvalidNoContent userInfo:nil],
        UNAuthorizationStatusDenied, SP_NOTIFICATIONS_REQUEST_FAILED, @"another error of the notification center is a failure");
    expect(false, [NSError errorWithDomain:NSCocoaErrorDomain code:UNErrorCodeNotificationsNotAllowed userInfo:nil],
        UNAuthorizationStatusDenied, SP_NOTIFICATIONS_REQUEST_FAILED, @"the same code in another domain is a failure");
    expect(true, nil, UNAuthorizationStatusAuthorized, SP_NOTIFICATIONS_REQUEST_POST, @"a granted authorization posts the notification");
    expect(false, nil, UNAuthorizationStatusDenied, SP_NOTIFICATIONS_REQUEST_REPORT, @"a denial without an error reports the state");
    return failures ? 1 : 0;
}}
