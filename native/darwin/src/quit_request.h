#include <stdbool.h>

// 운영체제의 종료 요청(kAEQuitApplication Apple event: Dock 의 종료, 로그아웃, 재시작, 다른 프로그램의 quit)의
// 처리기를 설치한다. 처리기는 event 를 보류하고 메인 스레드에서 request 를 부른다. 호스트는 저장을 마치고 끝나기
// 직전에 sp_quit_request_answer 로 보류한 event 에 오류 없이 답한다. 한 번만 설치하며, 두 번째 설치는 false 다.
// 애플리케이션이 실행을 마친 뒤(finishLaunching 뒤) 메인 스레드에서 호출한다.
bool sp_quit_request_install(void (^request)(void));

// 보류한 종료 요청 event 에 모두 오류 없이 답한다. 보류한 event 가 없으면 아무것도 하지 않는다. 메인 스레드에서 호출한다.
void sp_quit_request_answer(void);
