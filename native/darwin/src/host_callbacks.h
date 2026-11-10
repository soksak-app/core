#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "input_inject.h"

// One declaration source for the native-to-host ABI. V callbacks return no value; R callbacks return a value.
// Contexts are integer handle tokens, never Go pointers. Generic native void* cookies are converted in C before dispatch.
// Pointer arguments are borrowed for the call, except the ownership transfers below:
// - core_root_serve returns malloc-compatible bytes and content_type for native code to free.
// - native_settled_done transfers its nullable malloc-compatible message to the host, which frees it.
// - native_settled_present transfers a copied completion block; the host consumes it exactly once through
//   sp_host_presentation_complete, after which that pointer is invalid.
#define SP_HOST_CALLBACKS(X) \
    X(V, void, native_committed, (unsigned long long identifier), (identifier)) \
    X(V, void, native_terminated, (unsigned long long identifier), (identifier)) \
    X(V, void, native_message, (unsigned long long identifier, char *message), (identifier, message)) \
    X(V, void, file_dropped, (uintptr_t context, char *json), (context, json)) \
    X(V, void, file_drop_released, (uintptr_t context), (context)) \
    X(V, void, image_released, (uintptr_t context, uint64_t generation, uint64_t raster, int sequence), (context, generation, raster, sequence)) \
    X(V, void, image_changed, (uintptr_t context, char *json), (context, json)) \
    X(V, void, native_start_page_ready, (uintptr_t context, char *failure), (context, failure)) \
    X(V, void, native_layout_ready, (uintptr_t context, bool allowed), (context, allowed)) \
    X(V, void, native_presentation_done, (uintptr_t context), (context)) \
    X(V, void, native_settled_present, (uintptr_t context, void *presented), (context, presented)) \
    X(V, void, native_settled_present_ended, (uintptr_t context), (context)) \
    X(V, void, native_layout_started, (uintptr_t window), (window)) \
    X(V, void, native_layout_ended, (uintptr_t window), (window)) \
    X(V, void, native_settled_done, (uintptr_t context, double displayed, char *message), (context, displayed, message)) \
    X(V, void, notification_event, (uintptr_t context, char *json), (context, json)) \
    X(V, void, quit_request, (int sender_pid, char *sender), (sender_pid, sender)) \
    X(V, void, native_ui_run, (uintptr_t context), (context)) \
    X(V, void, native_responder_changed, (uintptr_t context), (context)) \
    X(V, void, native_fullscreen_done, (uintptr_t context), (context)) \
    X(V, void, surface_pressed, (uintptr_t owner, void *view), (owner, view)) \
    X(V, void, surface_point, (uintptr_t owner, int phase, double x, double y), (owner, phase, x, y)) \
    X(V, void, input_delivered, (uintptr_t context, int result, sp_input_held *held), (context, result, held)) \
    X(V, void, input_activated, (uintptr_t context, int result, char *frontmost), (context, result, frontmost)) \
    X(V, void, document_changed, (uintptr_t context, char *state), (context, state)) \
    X(V, void, document_message, (uintptr_t context, char *value), (context, value)) \
    X(V, void, view_message, (uintptr_t context, char *value), (context, value)) \
    X(V, void, view_ended, (uintptr_t context), (context)) \
    X(V, void, view_responsiveness, (uintptr_t context, bool responsive), (context, responsive)) \
    X(V, void, document_stream, (uintptr_t context, char *value), (context, value)) \
    X(R, bool, core_root_serve, (uintptr_t context, char *plugin, char *path, void **bytes, size_t *length, char **content_type), (context, plugin, path, bytes, length, content_type)) \
    X(V, void, document_queried, (uintptr_t context, char *value), (context, value)) \
    X(V, void, document_event, (uintptr_t context, char *value), (context, value)) \
    X(V, void, memory_pressure, (char *level, unsigned long long sequence), (level, sequence)) \
    X(V, void, dock_new_window, (void), ()) \
    X(V, void, mouse_buttons_changed, (uintptr_t context, unsigned long long mask), (context, mask))

// These callbacks exist only in the diagnostic host build.
#define SP_HOST_DIAGNOSTIC_CALLBACKS(X) \
    X(V, void, native_input_source_adopted, (uintptr_t context, char *failure), (context, failure)) \
    X(V, void, window_objects_counted, (uintptr_t context, long compositions, long hosts, long registrations, bool reached), (context, compositions, hosts, registrations, reached)) \
    X(V, void, page_objects_counted, (uintptr_t context, long elements, long documents, char *failure), (context, elements, documents, failure)) \
    X(V, void, delivered_notifications, (uintptr_t context, char *json), (context, json)) \
    X(V, void, document_frame_identity_done, (uintptr_t context, char *reply, char *failure), (context, reply, failure)) \
    X(V, void, input_reference_reply, (uintptr_t context, char *value, char *failure), (context, value, failure)) \
    X(V, void, process_exit_answered, (uintptr_t context, bool exited), (context, exited))

typedef struct {
#define SP_HOST_CALLBACK_FIELD(mode, result, name, parameters, arguments) result (*name) parameters;
    SP_HOST_CALLBACKS(SP_HOST_CALLBACK_FIELD)
#undef SP_HOST_CALLBACK_FIELD
} sp_host_callbacks;

typedef struct {
#define SP_HOST_DIAGNOSTIC_CALLBACK_FIELD(mode, result, name, parameters, arguments) result (*name) parameters;
    SP_HOST_DIAGNOSTIC_CALLBACKS(SP_HOST_DIAGNOSTIC_CALLBACK_FIELD)
#undef SP_HOST_DIAGNOSTIC_CALLBACK_FIELD
} sp_host_diagnostic_callbacks;

// Install once before any native work starts. Every field is required. The table is copied, while function addresses must
// remain valid until process exit. NULL means success; errors are static strings and leave the current registration unchanged.
const char *sp_host_callbacks_install(const sp_host_callbacks *callbacks);
const char *sp_host_diagnostic_callbacks_install(const sp_host_diagnostic_callbacks *callbacks);

// On the main thread, invoke and release the copied completion block received by native_settled_present, exactly once.
// failure is nullable and borrowed only during the invocation.
void sp_host_presentation_complete(void *completion, const char *failure);

// Call only through hostRunOnWorker/ON_WORKER. Calling before installation aborts and names the missing entry.
#define SP_HOST_CALLBACK_DECLARE(mode, result, name, parameters, arguments) result sp_host_callback_##name parameters;
SP_HOST_CALLBACKS(SP_HOST_CALLBACK_DECLARE)
#undef SP_HOST_CALLBACK_DECLARE

#define SP_HOST_DIAGNOSTIC_CALLBACK_DECLARE(mode, result, name, parameters, arguments) result sp_host_diagnostic_callback_##name parameters;
SP_HOST_DIAGNOSTIC_CALLBACKS(SP_HOST_DIAGNOSTIC_CALLBACK_DECLARE)
#undef SP_HOST_DIAGNOSTIC_CALLBACK_DECLARE
