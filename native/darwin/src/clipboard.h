#include <stddef.h>

// macOS 사용자 클립보드의 명시적 타입 접근. 모든 함수는 메인 스레드에서 호출한다.
// name 이 NULL 이면 NSPasteboard.generalPasteboard 를 사용한다. 그 밖에는 named pasteboard 를 연다.
void *sp_clipboard_open(const char *name);
void sp_clipboard_close(void *clipboard);

// 각 결과는 호출자가 free() 해야 하는 UTF-8 JSON 문자열이다.
// 결과 status 는 "ok", "absent", "error" 중 하나다.
// text 결과: {status, type:"text", text} 또는 {status, error}.
char *sp_clipboard_read_text(void *clipboard);
char *sp_clipboard_write_text(void *clipboard, const char *text);

// PNG 결과: {status, type:"png", base64} 또는 {status, error}.
// PNG 입력과 출력은 SP_CLIPBOARD_MAX_BYTES 를 초과할 수 없다.
char *sp_clipboard_read_png(void *clipboard);
char *sp_clipboard_write_png(void *clipboard, const unsigned char *bytes, size_t length);

// 파일 URL 결과: {status, type:"fileURLs", urls:[string, ...]} 또는 {status, error}.
char *sp_clipboard_read_file_urls(void *clipboard);

#define SP_CLIPBOARD_MAX_BYTES (16u * 1024u * 1024u)
