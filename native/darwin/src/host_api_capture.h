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
// Each answers context with one capture_answered callback on the worker; the call waits on a thread of its own.
void scheduleCaptureOpen(long windowNumber, bool display, uint64_t token, uintptr_t context);
void scheduleCaptureWait(uint64_t token, uintptr_t context);
void scheduleCaptureStop(double after, uint64_t token, uintptr_t context);
void scheduleCaptureStill(const long *windowNumbers, int count, const char *path, uint64_t token, uintptr_t context);
// Ends the wait of the capture call of token from any thread.
void endCaptureWait(uint64_t token, const char *reason);
void main_surfaceLayoutTraceStart(void);
size_t main_surfaceLayoutTraceStop(double *out, size_t capacity);
uint64_t main_surfaceLayoutTraceRequested(void);
void main_surfaceLayoutTracePresented(uint64_t ticket);
