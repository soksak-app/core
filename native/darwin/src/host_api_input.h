#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host binding entry points. Window and callback tokens retain their uintptr_t representation.
void activateWindowAt(uintptr_t window, double x, double y, uintptr_t handle);
void injectPointer(uintptr_t window, char *pointer, double x, double y, int phase, int button, double deltaX, double deltaY, int clicks,
    uintptr_t handle);
uintptr_t surfaceWatchMouse(uintptr_t nsWindow, uintptr_t owner);
void surfaceUnwatchMouse(uintptr_t monitor);
int main_sp_input_key(uintptr_t window, const char *key, const char *text, unsigned int modifiers, bool down);
int main_sp_input_text(uintptr_t window, int phase, const char *text, long selection_start, long selection_length, long replacement_start,
    long replacement_length);
