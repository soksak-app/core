#include "host_api_window.h"
#include <stdlib.h>
#include "webview_geometry.h"
#include "window_controls.h"
#include "window_facts.h"
#include "window_fullscreen.h"
#include "window_motion.h"
#include "window_reveal.h"
#include "main_thread.h"

#import <Cocoa/Cocoa.h>

// The native calls of this file run on the main thread (main_thread.h).
void main_sp_window_end_responder_observation(void *observation) {
    hostRunOnMain(^{ sp_window_end_responder_observation(observation); });
}
double main_windowTitlebarHeight(uintptr_t window) { return ON_MAIN(double, windowTitlebarHeight((void *)window)); }
bool main_windowSetTitlebarHeight(uintptr_t window, double height, char **failure) {
    return ON_MAIN(bool, windowSetTitlebarHeight((void *)window, height, failure));
}
void main_windowControls(uintptr_t window, double *out) { hostRunOnMain(^{ windowControls((void *)window, out); }); }
char *main_sp_window_facts(uintptr_t window) {
    return ON_MAIN(char *, sp_window_facts((void *)window, sp_window_composition((void *)window)));
}
bool main_sp_window_on_screen(uintptr_t window) { return ON_MAIN(bool, sp_window_on_screen((void *)window)); }
char *main_sp_window_color_space_facts(uintptr_t window) { return ON_MAIN(char *, sp_window_color_space_facts((void *)window)); }
char *main_sp_window_hit(uintptr_t window, double x, double y) {
    return ON_MAIN(char *, sp_window_hit((void *)window, sp_window_composition((void *)window), x, y));
}
bool main_sp_window_move(uintptr_t window, double x, double y) { return ON_MAIN(bool, sp_window_move((void *)window, x, y)); }
char *main_sp_screens(void) { return ON_MAIN(char *, sp_screens()); }
void main_windowResizeInstant(void) { hostRunOnMain(^{ windowResizeInstant(); }); }
bool main_sp_window_reveal_after_load(uintptr_t window, char **error) {
    return ON_MAIN(bool, sp_window_reveal_after_load((void *)window, error));
}
bool main_sp_window_place_new(uintptr_t window, char **error) {
    return ON_MAIN(bool, sp_window_place_new((void *)window, error));
}
void main_sp_window_show(uintptr_t window) { hostRunOnMain(^{ sp_window_show((void *)window); }); }
