#include "host_api_clipboard.h"

#include <stdlib.h>
#include "clipboard.h"
#include "main_thread.h"

// The native calls run on the main thread (main_thread.h).
void *main_sp_clipboard_open(const char *name) { return ON_MAIN(void *, sp_clipboard_open(name)); }
void main_sp_clipboard_close(void *clipboard) { hostRunOnMain(^{ sp_clipboard_close(clipboard); }); }
char *main_sp_clipboard_read_text(void *clipboard) { return ON_MAIN(char *, sp_clipboard_read_text(clipboard)); }
char *main_sp_clipboard_write_text(void *clipboard, const char *text) {
    return ON_MAIN(char *, sp_clipboard_write_text(clipboard, text));
}
char *main_sp_clipboard_read_png(void *clipboard) { return ON_MAIN(char *, sp_clipboard_read_png(clipboard)); }
char *main_sp_clipboard_read_file_urls(void *clipboard) { return ON_MAIN(char *, sp_clipboard_read_file_urls(clipboard)); }
