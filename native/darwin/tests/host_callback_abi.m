// Test-only native caller for the generated cgo-free callback ABI.
#include "host_callbacks.h"
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

static int context;
static sp_input_held held;
static char text[] = "borrowed";
void *sp_test_callback_context(void) { return &context; }
void *sp_test_callback_held(void) { return &held; }
char *sp_test_callback_text(void) { return text; }
void *sp_test_callback_bytes(void) {
    unsigned char *bytes = malloc(4);
    memcpy(bytes, (unsigned char[]){0, 255, 0, 73}, 4);
    return bytes;
}
char *sp_test_callback_kind(void) { return strdup("application/octet-stream"); }
void sp_test_callback_free(void *pointer) { free(pointer); }

size_t sp_test_callback_layout(size_t *offsets, bool diagnostic) {
    size_t i = 0;
    if (diagnostic) {
#define OFFSET(mode, result, name, parameters, arguments) offsets[i++] = offsetof(sp_host_diagnostic_callbacks, name);
        SP_HOST_DIAGNOSTIC_CALLBACKS(OFFSET)
#undef OFFSET
        return sizeof(sp_host_diagnostic_callbacks);
    }
#define OFFSET(mode, result, name, parameters, arguments) offsets[i++] = offsetof(sp_host_callbacks, name);
    SP_HOST_CALLBACKS(OFFSET)
#undef OFFSET
    return sizeof(sp_host_callbacks);
}

int sp_test_callback_run(void) {
    const uint64_t identifier = UINT64_C(0xfedcba9876543210);
    const uintptr_t token = UINT64_C(0xfedcba9876543201);
    sp_host_callback_native_committed(identifier);
    sp_host_callback_native_terminated(identifier);
    sp_host_callback_native_message(identifier, text);
    sp_host_callback_file_dropped(token, text);
    sp_host_callback_file_drop_released(token);
    sp_host_callback_image_released(token, identifier, identifier, -37);
    sp_host_callback_image_changed(token, text);
    sp_host_callback_native_start_page_ready(token, text);
    sp_host_callback_native_layout_ready(token, true);
    sp_host_callback_native_presentation_done(token);
    sp_host_callback_native_join_ended(token, text);
    // This ABI fixture checks opaque pointer identity; completion ownership has its native owner test.
    sp_host_callback_native_settled_present(token, &context);
    sp_host_callback_native_settled_present_ended(token);
    sp_host_callback_native_layout_started(token);
    sp_host_callback_native_layout_ended(token);
    sp_host_callback_native_settled_done(token, -12.5, strdup("transferred"));
    sp_host_callback_notification_event(token, text);
    sp_host_callback_quit_request(-37, text);
    sp_host_callback_native_ui_run(token);
    sp_host_callback_native_responder_changed(token);
    sp_host_callback_native_cursor_changed(token);
    sp_host_callback_native_sheet_changed(token);
    sp_host_callback_native_dialog_requested(token, identifier, text);
    sp_host_callback_native_dialog_answered(token, text);
    sp_host_callback_native_fullscreen_done(token, -37, text);
    sp_host_callback_surface_pressed(token, &context);
    sp_host_callback_surface_point(token, -37, -12.5, -12.5);
    sp_host_callback_input_delivered(token, -37, &held);
    sp_host_callback_input_activated(token, -37, text);
    sp_host_callback_document_changed(token, text);
    sp_host_callback_document_message(token, text);
    sp_host_callback_view_message(token, text);
    sp_host_callback_view_ended(token);
    sp_host_callback_view_responsiveness(token, true);
    sp_host_callback_document_stream(token, text);
    void *bytes = NULL;
    size_t length = 0;
    char *kind = NULL;
    bool served = sp_host_callback_core_root_serve(token, text, text, &bytes, &length, &kind);
    bool valid = served && bytes && length == 4 && !memcmp(bytes, (unsigned char[]){0, 255, 0, 73}, 4) && kind && !strcmp(kind, "application/octet-stream");
    free(bytes);
    free(kind);
    if (!valid) return 2;
    sp_host_callback_document_queried(token, text);
    sp_host_callback_document_event(token, text);
    sp_host_callback_memory_pressure(text, identifier);
    sp_host_callback_dock_new_window();
    sp_host_callback_mouse_buttons_changed(token, identifier);
    sp_host_diagnostic_callback_native_input_source_adopted(token, text);
    sp_host_diagnostic_callback_window_objects_counted(token, -83, -83, -83, true);
    sp_host_diagnostic_callback_page_objects_counted(token, -83, -83, text);
    sp_host_diagnostic_callback_delivered_notifications(token, text);
    sp_host_diagnostic_callback_input_reference_reply(token, text, text);
    sp_host_diagnostic_callback_process_exit_answered(token, true);
    sp_host_diagnostic_callback_capture_answered(token, -83, text);
    return 0;
}

// Generic native APIs keep an integer handle as their opaque cookie.
void sp_test_callback_token(uintptr_t token) {
    void *cookie = (void *)token;
    sp_host_callback_image_changed((uintptr_t)cookie, text);
}
