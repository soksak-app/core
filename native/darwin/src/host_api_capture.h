#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host-facing native operations; callback contexts are integer tokens, never Go pointers.
bool scheduleDocumentFrameIdentityStart(void *document, uint64_t generation, uintptr_t context);
bool scheduleDocumentFrameIdentityFreeze(uint64_t generation, uintptr_t context);
bool scheduleDocumentFrameIdentityRemove(uint64_t generation, uintptr_t context);
void listDeliveredNotifications(void);
int windowNumbers(uintptr_t nsWindow, long* out, int max);
void main_surfaceLayoutTraceStart(void);
size_t main_surfaceLayoutTraceStop(double *out, size_t capacity);
uint64_t main_surfaceLayoutTraceRequested(void);
void main_surfaceLayoutTracePresented(uint64_t ticket);
