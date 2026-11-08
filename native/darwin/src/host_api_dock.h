#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host-facing native operations; callback contexts are integer tokens, never Go pointers.
bool installDockMenu(void);
char *main_sp_dock_items(void);
char *main_sp_menu_items(void);
char *main_sp_preferred_language(void);
const char *main_sp_menu_select(uintptr_t window, const char *menu, const char *title);
uintptr_t main_sp_app_main_window(void);
bool main_sp_dock_select(const char *title);
