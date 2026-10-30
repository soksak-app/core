#ifndef SOKSAK_PROCESS_IDENTITY_H
#define SOKSAK_PROCESS_IDENTITY_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// Registers the current process with its LaunchServices display name and sets the exact name.
// LaunchServices lists a process that this call registers with the display name from its registration.
// A sidecar passes its declared displayName URI. Returns 0 only after exact readback.
// On failure, writes a NUL-terminated operation and status to error when capacity permits.
int soksak_process_set_display_name(const char *display_name, char *error, size_t error_capacity);

#ifdef __cplusplus
}
#endif

#endif
