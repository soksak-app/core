#include "host_api_notifications.h"

#include <stdlib.h>
#include "notifications.h"
#include "main_thread.h"
#include "host_callbacks.h"

// The callback runs its Go function on the worker, and the native calls run on the main thread (main_thread.h).
static void notificationEventBridge(void *context, const char *json) {
    hostRunOnWorker(^{ sp_host_callback_notification_event((uintptr_t)context, (char *)json); });
}
const char *startNotifications(void) {
    return ON_MAIN(const char *, sp_notifications_start(notificationEventBridge, NULL));
}
void main_sp_notifications_post(const char *identifier, const char *title, const char *body) {
    hostRunOnMain(^{ sp_notifications_post(identifier, title, body); });
}
void main_sp_notifications_remove(const char *identifier) { hostRunOnMain(^{ sp_notifications_remove(identifier); }); }
