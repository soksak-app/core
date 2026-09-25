// URL 을 그 스킴의 사용자 기본 애플리케이션으로 연다. 스킴 제한은 호스트가 검사한다.
// 성공하면 NULL 을, 실패하면 호출자가 free() 해야 하는 UTF-8 오류 문자열을 반환한다.
char *sp_link_open(const char *url);
