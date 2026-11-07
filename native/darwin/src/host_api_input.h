#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host binding entry points. Window and callback tokens retain their uintptr_t representation.
void activateWindowAt(uintptr_t window, double x, double y, double timeout, uintptr_t handle);
void injectPointer(uintptr_t window, char *pointer, double x, double y, int phase, int button, double deltaX, double deltaY, int clicks,
    double receive, uintptr_t handle);
uintptr_t surfaceWatchMouse(uintptr_t nsWindow, uintptr_t owner);
void surfaceUnwatchMouse(uintptr_t monitor);
int main_sp_input_key(uintptr_t window, const char *key, const char *text, unsigned int modifiers, bool down);
