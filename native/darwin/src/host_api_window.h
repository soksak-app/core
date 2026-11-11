#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host-facing native operations retain their existing main-thread dispatch contract.
bool nativeWindowFullscreen(uintptr_t window, bool on, uintptr_t callback);
void *nativeWindowObserveResponder(uintptr_t window, uintptr_t callback);
void *nativeWindowObserveCursor(uintptr_t window, uintptr_t callback);
void *nativeWindowObserveSheet(uintptr_t window, uintptr_t callback);
void nativeWindowPrepare(uintptr_t window);
void main_sp_window_end_responder_observation(void *observation);
void main_sp_input_virtual_end_cursor_observation(void *observation);
void main_sp_window_end_sheet_observation(void *observation);
double main_windowTitlebarHeight(uintptr_t window);
bool main_windowSetTitlebarHeight(uintptr_t window, double height, char **failure);
void main_windowControls(uintptr_t window, double *out);
char *main_sp_window_facts(uintptr_t window);
bool main_sp_window_on_screen(uintptr_t window);
char *main_sp_window_color_space_facts(uintptr_t window);
char *main_sp_window_hit(uintptr_t window, double x, double y);
bool main_sp_window_move(uintptr_t window, double x, double y);
bool main_sp_window_raise(uintptr_t window);
bool main_sp_window_lower(uintptr_t window);
char *main_sp_screens(void);
void main_windowResizeInstant(void);
bool main_sp_window_reveal_after_load(uintptr_t window, char **error);
bool main_sp_window_place_new(uintptr_t window, char **error);
void main_sp_window_show(uintptr_t window);
