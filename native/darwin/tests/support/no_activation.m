#import <Cocoa/Cocoa.h>
#import <stdio.h>
#import <stdlib.h>
#import <unistd.h>

// make test 의 검사는 애플리케이션을 활성화하지 않는다. 모든 검사가 이 파일을 링크하며, 종료할 때 프로세스가
// 활성이면 실패한다. make test-activation 의 검사는 활성화하기 전에 sp_test_declare_activation 을 호출한다.
void sp_test_declare_activation(void);

static bool declared;

void sp_test_declare_activation(void) { declared = true; }

// 종료할 때 활성화를 선언하지 않은 검사의 프로세스가 활성이면 종료 코드를 1 로 바꾼다.
static void failWhenActive(void) {
    if (declared || NSApp == nil || !NSApp.isActive) return;
    fprintf(stderr, "FAIL: the test process is active at exit; a make test check must not activate the application\n");
    _exit(1);
}

__attribute__((constructor)) static void install(void) { atexit(failWhenActive); }
