#import <Cocoa/Cocoa.h>
#import <UserNotifications/UserNotifications.h>
#import "notifications.h"
#import "observe.h"

// Delegate of the notification center. Shows the banner even while the application is active, and reports the identifier of the clicked notification.
@interface SPNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end

static sp_notification_event handler;
static void *handlerContext;
static SPNotificationDelegate *delegate;
// Last failure of an authorization request, post, or removal. Reported together with the state event.
static NSString *lastError;
// Identifiers that were requested to post and not removed. A notification removed before its post finished is removed again after the post finishes.
static NSMutableSet<NSString *> *current;

static void emit(NSDictionary *event) {
    NSData *json = [NSJSONSerialization dataWithJSONObject:event options:0 error:NULL];
    NSString *text = [[[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] autorelease];
    handler(handlerContext, text.UTF8String);
}

static NSString *authorizationName(UNAuthorizationStatus status) {
    switch (status) {
        case UNAuthorizationStatusNotDetermined: return @"notDetermined";
        case UNAuthorizationStatusDenied: return @"denied";
        case UNAuthorizationStatusAuthorized: return @"authorized";
        case UNAuthorizationStatusProvisional: return @"provisional";
    }
    return [NSString stringWithFormat:@"unknown %ld", (long)status];
}

// Reports the current authorization and the last failure of the notification center. then receives the authorization and runs on the main thread.
static void reportState(void (^then)(UNAuthorizationStatus)) {
    void (^next)(UNAuthorizationStatus) = [[then copy] autorelease];
    [[UNUserNotificationCenter currentNotificationCenter] getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        UNAuthorizationStatus status = settings.authorizationStatus;
        dispatch_async(dispatch_get_main_queue(), ^{
            emit(@{@"type": @"state", @"authorization": authorizationName(status), @"error": lastError ?: NSNull.null});
            if (next) next(status);
        });
    }];
}

static void fail(NSString *operation, NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
        [lastError release];
        lastError = [[NSString stringWithFormat:@"%@: %@", operation, error.localizedDescription] retain];
        reportState(nil);
    });
}

@implementation SPNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
    sp_observe_delivered("notifications.delegate");
    completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList);
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completionHandler {
    sp_observe_delivered("notifications.delegate");
    NSString *identifier = [[response.notification.request.identifier copy] autorelease];
    BOOL opened = [response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier];
    dispatch_async(dispatch_get_main_queue(), ^{
        if (opened) emit(@{@"type": @"activated", @"identifier": identifier});
    });
    completionHandler();
}
@end

const char *sp_notifications_start(sp_notification_event event, void *context) {
    NSCAssert(NSThread.isMainThread, @"notifications require the UI thread");
    // In a process outside a bundle, opening the notification center raises an exception that ends the process.
    if (NSBundle.mainBundle.bundleIdentifier == nil) {
        return "system notifications require the process to run from an application bundle";
    }
    if (delegate) return "system notifications are already started";
    handler = event;
    handlerContext = context;
    delegate = [[SPNotificationDelegate alloc] init];
    if (!sp_observe_delegate("notifications.delegate", SP_OBSERVE_RECORD, [UNUserNotificationCenter currentNotificationCenter], delegate)) {
        [delegate release];
        delegate = nil;
        handler = NULL;
        handlerContext = NULL;
        return "the notification center takes no delegate";
    }
    reportState(nil);
    return NULL;
}

static void add(NSString *identifier, NSString *title, NSString *body) {
    UNMutableNotificationContent *content = [[[UNMutableNotificationContent alloc] init] autorelease];
    content.title = title;
    content.body = body;
    UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:identifier content:content trigger:nil];
    [[UNUserNotificationCenter currentNotificationCenter] addNotificationRequest:request withCompletionHandler:^(NSError *error) {
        if (error) {
            fail(@"post", error);
            return;
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            if (![current containsObject:identifier]) {
                [[UNUserNotificationCenter currentNotificationCenter] removeDeliveredNotificationsWithIdentifiers:@[identifier]];
                return;
            }
            emit(@{@"type": @"posted", @"identifier": identifier});
        });
    }];
}

void sp_notifications_post(const char *identifier, const char *title, const char *body) {
    NSCAssert(NSThread.isMainThread && delegate, @"notifications must be started on the UI thread");
    NSString *name = [NSString stringWithUTF8String:identifier];
    NSString *heading = [NSString stringWithUTF8String:title];
    NSString *text = [NSString stringWithUTF8String:body];
    if (!current) current = [[NSMutableSet alloc] init];
    [current addObject:name];
    reportState(^(UNAuthorizationStatus status) {
        if (status == UNAuthorizationStatusNotDetermined) {
            // Authorization is requested once at the first notification. The result is reported again as a state event.
            [[UNUserNotificationCenter currentNotificationCenter] requestAuthorizationWithOptions:UNAuthorizationOptionAlert
                completionHandler:^(BOOL granted, NSError *error) {
                if (error) {
                    fail(@"request permission", error);
                    return;
                }
                dispatch_async(dispatch_get_main_queue(), ^{
                    reportState(nil);
                    if (granted) add(name, heading, text);
                });
            }];
            return;
        }
        if (status != UNAuthorizationStatusDenied) add(name, heading, text);
    });
}

void sp_notifications_remove(const char *identifier) {
    NSCAssert(NSThread.isMainThread && delegate, @"notifications must be started on the UI thread");
    NSArray *identifiers = @[[NSString stringWithUTF8String:identifier]];
    [current removeObject:identifiers[0]];
    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
    [center removePendingNotificationRequestsWithIdentifiers:identifiers];
    [center removeDeliveredNotificationsWithIdentifiers:identifiers];
}

void sp_notifications_delivered(void (*done)(void *context, const char *json), void *context) {
    NSCAssert(NSThread.isMainThread && delegate, @"notifications must be started on the UI thread");
    [[UNUserNotificationCenter currentNotificationCenter] getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> *notifications) {
        NSMutableArray *list = [NSMutableArray array];
        for (UNNotification *notification in notifications) {
            UNNotificationContent *content = notification.request.content;
            [list addObject:@{@"identifier": notification.request.identifier, @"title": content.title, @"body": content.body}];
        }
        NSData *json = [NSJSONSerialization dataWithJSONObject:list options:0 error:NULL];
        NSString *text = [[[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] autorelease];
        dispatch_async(dispatch_get_main_queue(), ^{ done(context, text.UTF8String); });
    }];
}
