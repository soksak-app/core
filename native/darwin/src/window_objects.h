#include <stdbool.h>

// 라이브러리가 창과 웹뷰에 붙이는 객체 가운데, 그 수명이 창과 웹뷰의 해제를 나타내는 객체의 살아 있는 수.
// 각 객체는 초기화에서 수를 늘리고 dealloc 에서 줄인다. 닫은 창이 해제되면 그 창의 객체 수가 빠진다.
typedef struct {
    // SPWindowComposition: 창의 콘텐츠 뷰 안에 있고 메인 웹뷰를 보유한다. 창이 해제되어야 해제된다.
    long windowCompositions;
    // SPSurfaceHost: 논리 표면과 표면에 붙인 웹뷰의 컨테이너. 논리 표면은 메인 웹뷰를 보유한다.
    long surfaceHosts;
    // SPInputRegistration: 입력을 등록한 웹뷰(메인, 모달, 표면 웹뷰)의 연결 객체. 웹뷰가 해제되어야 해제된다.
    long inputRegistrations;
} sp_window_objects;

// 지금 살아 있는 수를 반환한다.
sp_window_objects sp_window_objects_count(void);

typedef void (*sp_window_objects_done)(void *context, const sp_window_objects *counts, bool reached);

// 애플리케이션 정의 이벤트를 이벤트 대기열에 넣고, 애플리케이션이 그 이벤트를 처리한 뒤의 수가 expected 와 같아질 때
// 그 수와 reached true 를 done 에 준다. seconds 안에 같아지지 않으면 그때의 수와 reached false 를 준다. expected 가
// NULL 이면 처음 넣은 이벤트를 처리한 뒤의 수를 reached true 로 준다.
// AppKit 은 이벤트 하나를 처리하는 반복이 끝날 때 그 반복의 자동 해제 풀을 비우므로, 창을 닫는 동안 자동 해제된
// 객체는 이벤트가 없으면 다음 사용자 입력까지 남는다. 풀을 비우는 동안 해제된 객체가 자동 해제한 객체는 다음 반복의
// 풀에서 해제되고, 화면에 있던 창은 AppKit 이 닫기 애니메이션이 끝날 때까지 보유한다. 그래서 요청이 기다리는 동안
// 메인 실행 반복이 잠들기 전마다 이벤트 하나를 넣고, 그 이벤트를 처리한 뒤마다 수를 비교한다. 메인 스레드에서
// 호출하고 done 은 메인 스레드에서 한 번 호출된다.
void sp_window_objects_when(const sp_window_objects *expected, double seconds, sp_window_objects_done done,
    void *context);

#ifdef __OBJC__
typedef enum {
    SP_WINDOW_OBJECT_COMPOSITION,
    SP_WINDOW_OBJECT_SURFACE_HOST,
    SP_WINDOW_OBJECT_INPUT_REGISTRATION,
} sp_window_object_kind;

// 라이브러리 객체의 초기화(+1)와 dealloc(-1)이 부른다.
void sp_window_object_change(sp_window_object_kind kind, long delta);
#endif
