#include <stddef.h>

// Explicitly typed access to the macOS user clipboard. Every function is called on the main thread.
// If name is NULL, NSPasteboard.generalPasteboard is used. Otherwise a named pasteboard is opened.
void *sp_clipboard_open(const char *name);
void sp_clipboard_close(void *clipboard);

// Each result is a UTF-8 JSON string that the caller must free().
// The status of a result is one of "ok", "absent", and "error".
// text result: {status, type:"text", text} or {status, error}.
char *sp_clipboard_read_text(void *clipboard);
char *sp_clipboard_write_text(void *clipboard, const char *text);

// PNG result: {status, type:"png", base64} or {status, error}.
// PNG input and output must not exceed SP_CLIPBOARD_MAX_BYTES.
char *sp_clipboard_read_png(void *clipboard);
char *sp_clipboard_write_png(void *clipboard, const unsigned char *bytes, size_t length);

// file URL result: {status, type:"fileURLs", urls:[string, ...]} or {status, error}.
char *sp_clipboard_read_file_urls(void *clipboard);

#define SP_CLIPBOARD_MAX_BYTES (16u * 1024u * 1024u)
