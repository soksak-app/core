#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host-facing native operations; callback contexts are integer tokens, never Go pointers.
void listDeliveredNotifications(void);
int windowNumbers(uintptr_t nsWindow, long* out, int max);
// Each answers context with one capture_answered callback on the worker; the call runs on a thread of its own.
// scheduleCaptureOpen answers 1 or 0 with the error of the open; scheduleCaptureStart answers 1 once still 0 is written, or 0
// with the error of the start; scheduleCaptureStop answers the number of written frames with the error of the recording;
// scheduleCaptureStill answers 1 or 0 with the error of the still.
void scheduleCaptureOpen(long windowNumber, bool display, uintptr_t context);
void scheduleCaptureStart(const char *directory, double gap, double seconds, int frames, uint64_t token, uintptr_t context);
void scheduleCaptureStop(double after, uint64_t token, uintptr_t context);
void scheduleCaptureStill(long windowNumber, const char *path, uintptr_t context);
// The recording of a new window from its first still (capture.h): main_sp_capture_hold_new_window sets the hold on the main
// thread, scheduleCaptureWaitNewWindow answers context with the number of the held window, or -1 and the end of its wait, and
// releaseCaptureNewWindow ends the hold from any thread, putting a held window on screen.
bool main_sp_capture_hold_new_window(char **error);
void scheduleCaptureWaitNewWindow(uint64_t token, uintptr_t context);
void releaseCaptureNewWindow(void);
// Ends the wait of the capture call of token from any thread.
void endCaptureWait(uint64_t token, const char *reason);
void main_surfaceLayoutTraceStart(void);
size_t main_surfaceLayoutTraceStop(double *out, size_t capacity);
uint64_t main_surfaceLayoutTraceRequested(void);
void main_surfaceLayoutTracePresented(uint64_t ticket);
