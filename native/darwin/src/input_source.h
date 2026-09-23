// 선택된 키보드 입력 소스를 읽고 바꾼다.
//
// 입력기 동작을 재현하는 창 검사가 사용자와 같은 입력 소스 순서(예: 영문 자판 뒤 한국어 2벌식)를
// 만들 때 사용한다. 두 함수 모두 메인 스레드에서 호출한다.
#pragma once
#include <stdbool.h>

// 현재 선택된 키보드 입력 소스의 식별자를 malloc 한 문자열로 반환한다. 호출자가 free 한다.
// 입력 소스를 읽지 못하면 NULL 을 반환한다.
char *sp_input_source_current(void);

// 켜져 있는 입력 소스 가운데 식별자가 같은 것을 선택한다. 없거나 선택하지 못하면 false 를 반환한다.
bool sp_input_source_select(const char *identifier);
