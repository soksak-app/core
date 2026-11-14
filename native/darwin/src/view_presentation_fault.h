#pragma once

#include <stdio.h>
#include <sys/types.h>

// The Darwin notification that releases the presentation callbacks which the fault point SOKSAK_FAULT_VIEW_PRESENTATION=hold holds
// (nativeWebviewAfterPresentation, webview.m). Darwin notifications reach every process, so the name carries the id of the process
// whose callbacks it releases: a test process that runs beside another one releases only its own held presentations.
#define SP_VIEW_PRESENTATION_FAULT_RELEASE_PREFIX "app.soksak.view.presentation.fault.release."

// Writes the release name of the process pid into name, which holds size bytes; 64 bytes hold every name.
static inline void sp_view_presentation_fault_release_name(pid_t pid, char *name, size_t size) {
    snprintf(name, size, SP_VIEW_PRESENTATION_FAULT_RELEASE_PREFIX "%d", (int)pid);
}
