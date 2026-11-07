#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host-facing native operations retain their existing main-thread dispatch contract.
void nativeWindowLayoutBegin(uintptr_t window, uint64_t ticket, uintptr_t callback);
void nativeWindowStartPage(uintptr_t window, uint64_t ticket, double height, uintptr_t callback);
bool nativeWindowAfterPresentation(uintptr_t window, uintptr_t callback);
bool nativeWindowJoinView(uintptr_t window, uint64_t ticket, void *view, uintptr_t callback);
void *nativeWindowMainPresentation(uintptr_t window);
void nativeWindowAfterSettled(uintptr_t window, void *present, uintptr_t callback);
void *nativeFunctionPresentation(uintptr_t present);
void nativeLayoutObserve(void);
void main_sp_host_presentation_complete(void *completion, const char *failure);
bool main_surfaceLayoutCommit(uintptr_t window, uint64_t ticket);
void main_surfaceLayoutCancel(uintptr_t window);
void main_surfaceLayoutCancelTicket(uintptr_t window, uint64_t ticket);
bool main_surfaceLayoutAbandonView(uintptr_t window, void *view);
void main_surfaceLayoutInjectSettledFailure(void);
