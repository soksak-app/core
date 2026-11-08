#include "host_api_dock.h"

#include <stdbool.h>
#include <stdlib.h>
#include "dock_menu.h"
#include "window_facts.h"
#include "main_thread.h"
#include "host_callbacks.h"

// The menu action runs its Go function on the worker, and the native calls run on the main thread (main_thread.h).
bool installDockMenu(void) {
    return ON_MAIN(bool, appInstallDockMenu(^{ hostRunOnWorker(^{ sp_host_callback_dock_new_window(); }); }));
}
char *main_sp_dock_items(void) { return ON_MAIN(char *, sp_dock_items()); }
char *main_sp_menu_items(void) { return ON_MAIN(char *, sp_menu_items()); }
char *main_sp_preferred_language(void) { return ON_MAIN(char *, sp_preferred_language()); }
const char *main_sp_menu_select(uintptr_t window, const char *menu, const char *title) { return ON_MAIN(const char *, sp_menu_select((void *)window, menu, title)); }
uintptr_t main_sp_app_main_window(void) { return (uintptr_t)ON_MAIN(void *, sp_app_main_window()); }
bool main_sp_dock_select(const char *title) { return ON_MAIN(bool, sp_dock_select(title)); }
