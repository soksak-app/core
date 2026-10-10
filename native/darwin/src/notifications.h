#include <stdbool.h>

// Notification center of the operating system (docs/spec/plugins.md#tab-reports). The notification center accepts only
// a process that runs in an application bundle. event receives a JSON string on the main thread.
//   {"type":"state","authorization":"notDetermined|denied|authorized|provisional","error":null|"<last failure>"}
//   {"type":"posted","identifier":"<notification identifier>"}    the notification center accepted the notification
//   {"type":"activated","identifier":"<notification identifier>"} the user clicked the notification
typedef void (*sp_notification_event)(void *context, const char *json);
// Becomes the delegate of the notification center and reports the current authorization once as a state event. Returns NULL on success and the reason on failure.
// A process outside a bundle and a second call fail. Call on the main thread.
const char *sp_notifications_start(sp_notification_event event, void *context);
// Posts the notification with identifier, replacing an earlier notification with the same identifier. Requests authorization first when it is undetermined.
// Authorization and failures are reported as state events. Call on the main thread.
void sp_notifications_post(const char *identifier, const char *title, const char *body);
// Removes the notification with identifier. Call on the main thread.
void sp_notifications_remove(const char *identifier);
// Diagnostics only. Passes the notifications remaining in the notification center to done on the main thread as the JSON [{"identifier","title","body"}].
void sp_notifications_delivered(void (*done)(void *context, const char *json), void *context);
