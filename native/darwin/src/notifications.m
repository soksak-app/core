#import <Cocoa/Cocoa.h>
#import <UserNotifications/UserNotifications.h>
#import "notifications.h"

// 알림 센터의 대리자. 애플리케이션이 활성일 때도 배너를 보이고, 누른 알림의 식별자를 알린다.
@interface SPNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end

static sp_notification_event handler;
static void *handlerContext;
static SPNotificationDelegate *delegate;
// 권한 요청, 게시, 제거의 마지막 실패. state 사건에 함께 알린다.
static NSString *lastError;
// 게시를 요청한 뒤 지우지 않은 식별자. 게시가 끝나기 전에 지워진 알림은 끝난 뒤 다시 지운다.
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

// 알림 센터의 현재 권한과 마지막 실패를 알린다. then 은 권한을 받아 메인 스레드에서 실행된다.
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
    completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList);
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completionHandler {
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
    // 번들 밖의 프로세스에서는 알림 센터를 여는 것만으로 예외가 나서 프로세스가 끝난다.
    if (NSBundle.mainBundle.bundleIdentifier == nil) {
        return "system notifications require the process to run from an application bundle";
    }
    if (delegate) return "system notifications are already started";
    handler = event;
    handlerContext = context;
    delegate = [[SPNotificationDelegate alloc] init];
    [UNUserNotificationCenter currentNotificationCenter].delegate = delegate;
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
            // 첫 알림에서 한 번 권한을 요청한다. 결과는 다시 state 사건으로 알린다.
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
