// 오류 한 줄 `error: <where>: <text>` 를 표준 오류에 한 번의 write 로 쓴다. 호스트는 표준 오류를 애플리케이션 로그로
// 바꾸므로 창 검사가 그 줄을 오류로 읽는다(docs/spec/hosts.md#application-log). 표준 오류에 쓰지 못하면 그 실패를 알릴
// 곳이 없으므로 프로세스를 끝낸다.
void sp_log_error(const char *where, const char *text);
