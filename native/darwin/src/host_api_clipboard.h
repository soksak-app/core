#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host-facing native operations; callback contexts are integer tokens, never Go pointers.
void *main_sp_clipboard_open(const char *name);
void main_sp_clipboard_close(void *clipboard);
char *main_sp_clipboard_read_text(void *clipboard);
char *main_sp_clipboard_write_text(void *clipboard, const char *text);
char *main_sp_clipboard_read_png(void *clipboard);
char *main_sp_clipboard_read_file_urls(void *clipboard);
