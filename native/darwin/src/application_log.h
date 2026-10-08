// 오류 한 줄 `error: <where>: <text>` 를 표준 오류에 한 번의 write 로 쓴다. 호스트는 표준 오류를 애플리케이션 로그로
// 바꾸므로 창 검사가 그 줄을 오류로 읽는다(docs/spec/hosts.md#application-log). 표준 오류에 쓰지 못하면 그 실패를 알릴
// 곳이 없으므로 프로세스를 끝낸다.
void sp_log_error(const char *where, const char *text);

// Installs the handlers of the fatal signals and of the uncaught exception of the process. Each writes one line
// `error: fatal: <signal name>` or `error: fatal: uncaught exception <name>: <reason>` to the standard error, and the
// process then ends by the signal that it had received or by the abort that follows the exception
// (docs/spec/diagnostics.md). A handler that was installed before is called after the line.
void sp_log_install_fatal_handlers(void);
