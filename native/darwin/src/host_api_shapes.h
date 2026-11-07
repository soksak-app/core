#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host-facing native operations retain their existing main-thread dispatch contract.
void shapeSetFrame(void* handle, double x, double y, double w, double h);
void surfaceRaise(void* handle);
void* shapeCreate(uintptr_t nsWindow, double x, double y, double w, double h);
void shapeSetStyle(void* handle, double radius, double lineWidth,
                          double fr, double fg, double fb, double fa,
                          double lr, double lg, double lb, double la);
void shapeDestroy(void* handle);
