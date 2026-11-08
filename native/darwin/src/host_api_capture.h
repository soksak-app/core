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
bool main_sp_capture_open(long windowNumber, bool display, char **error);
bool main_sp_capture_start(const char *directory, bool frameIdentity, char **error);
int main_sp_capture_stop(double after);
bool main_sp_capture_has_stream(void);
int main_sp_capture_wait(void);
bool main_sp_capture_limited(void);
double main_sp_capture_longest_gap(void);
bool main_sp_capture_still(const long *windowNumbers, int count, const char *path, char **error);
void main_surfaceLayoutTraceStart(void);
size_t main_surfaceLayoutTraceStop(double *out, size_t capacity);
uint64_t main_surfaceLayoutTraceRequested(void);
void main_surfaceLayoutTracePresented(uint64_t ticket);
