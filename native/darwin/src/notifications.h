#include <stdbool.h>

// 운영체제의 알림 센터(docs/spec/plugins.md#tab-reports). 알림 센터는 애플리케이션 번들에서 실행된
// 프로세스만 받는다. event 는 메인 스레드에서 JSON 문자열을 받는다.
//   {"type":"state","authorization":"notDetermined|denied|authorized|provisional","error":null|"<마지막 실패>"}
//   {"type":"posted","identifier":"<알림 식별자>"}    알림 센터가 알림을 받아들였다
//   {"type":"activated","identifier":"<알림 식별자>"} 사용자가 알림을 눌렀다
typedef void (*sp_notification_event)(void *context, const char *json);
// 알림 센터의 대리자가 되고 현재 권한을 state 사건으로 한 번 알린다. 성공하면 NULL, 실패하면 이유를 반환한다.
// 번들 밖의 프로세스와 두 번째 호출은 실패한다. 메인 스레드에서 호출한다.
const char *sp_notifications_start(sp_notification_event event, void *context);
// identifier 의 알림을 게시한다. 같은 식별자의 이전 알림을 바꾼다. 권한을 정하지 않았으면 먼저 요청한다.
// 권한과 실패는 state 사건으로 알린다. 메인 스레드에서 호출한다.
void sp_notifications_post(const char *identifier, const char *title, const char *body);
// identifier 의 알림을 지운다. 메인 스레드에서 호출한다.
void sp_notifications_remove(const char *identifier);
// 진단 전용. 알림 센터에 남아 있는 알림을 [{"identifier","title","body"}] JSON 으로 done 에 메인 스레드에서 준다.
void sp_notifications_delivered(void (*done)(void *context, const char *json), void *context);
