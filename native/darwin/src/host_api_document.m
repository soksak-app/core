// Native implementation of the host binding helpers formerly owned by document.go.
#include "host_api_document.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include "document_view.h"
#include "main_thread.h"
#include "host_callbacks.h"

// The callbacks run their Go functions on the worker, and the native calls of this file run on the main thread (main_thread.h).

static bool coreRootBridge(void *context, const char *plugin, const char *path, void **bytes, size_t *length, char **type) {
    return ON_WORKER(bool, sp_host_callback_core_root_serve((uintptr_t)context, (char *)plugin, (char *)path, bytes, length, type));
}

void coreRootSet(uintptr_t context) {
    hostRunOnMain(^{ sp_core_root_set_resolver(coreRootBridge, (void *)context); });
}

static void documentChangedBridge(void *context, const char *state) {
    hostRunOnWorker(^{ sp_host_callback_document_changed((uintptr_t)context, (char *)state); });
}
static void documentEventBridge(void *context, const char *event) {
    hostRunOnWorker(^{ sp_host_callback_document_event((uintptr_t)context, (char *)event); });
}

static void documentMessageBridge(void *context, const char *message) {
    hostRunOnWorker(^{ sp_host_callback_document_message((uintptr_t)context, (char *)message); });
}

static void viewMessageBridge(void *context, const char *message) {
    hostRunOnWorker(^{ sp_host_callback_view_message((uintptr_t)context, (char *)message); });
}

static void viewEndedBridge(void *context) {
    hostRunOnWorker(^{ sp_host_callback_view_ended((uintptr_t)context); });
}

static void documentStreamBridge(void *context, const char *message) {
    hostRunOnWorker(^{ sp_host_callback_document_stream((uintptr_t)context, (char *)message); });
}

static void documentQueriedBridge(void *context, const char *reply) {
    hostRunOnWorker(^{ sp_host_callback_document_queried((uintptr_t)context, (char *)reply); });
}

static void documentScrolledBridge(void *context, const char *reply) {
    hostRunOnWorker(^{ sp_host_callback_document_scrolled((uintptr_t)context, (char *)reply); });
}

static void documentConfirmBridge(void *context, const char *reply) {
    hostRunOnWorker(^{ sp_host_callback_document_confirmed((uintptr_t)context, (char *)reply); });
}

void documentConfirm(void *document, const char *kind, const char *origin, const char *summary, uintptr_t context) {
    hostRunOnMain(^{ sp_document_confirm(document, kind, origin, summary, documentConfirmBridge, (void *)context); });
}

static void documentCaptureBridge(void *context, const char *reply) {
    hostRunOnWorker(^{ sp_host_callback_document_captured((uintptr_t)context, (char *)reply); });
}

void documentCapture(void *document, int mode, int every_ms, int count, int for_ms, uintptr_t context) {
    hostRunOnMain(^{ sp_document_capture(document, mode, every_ms, count, for_ms, documentCaptureBridge, (void *)context); });
}

static void documentInputBridge(void *context, const char *reply) {
    hostRunOnWorker(^{ sp_host_callback_document_input((uintptr_t)context, (char *)reply); });
}

void documentInput(void *document, int action, double x, double y, double dx, double dy, const char *key, uintptr_t context) {
    hostRunOnMain(^{ sp_document_input(document, action, x, y, dx, dy, key, documentInputBridge, (void *)context); });
}

static void documentEvalBridge(void *context, const char *reply) {
    hostRunOnWorker(^{ sp_host_callback_document_evaled((uintptr_t)context, (char *)reply); });
}

void documentEval(void *document, const char *path, const char *source, bool await_promise, bool granted, uintptr_t context) {
    hostRunOnMain(^{ sp_document_eval(document, path, source, await_promise, granted, documentEvalBridge, (void *)context); });
}

static void documentActBridge(void *context, const char *reply) {
    hostRunOnWorker(^{ sp_host_callback_document_acted((uintptr_t)context, (char *)reply); });
}

void documentAct(void *document, const char *path, int ref, int action, const char *value, bool granted, uintptr_t context) {
    hostRunOnMain(^{ sp_document_act(document, path, ref, action, value, granted, documentActBridge, (void *)context); });
}

static void documentReadBridge(void *context, const char *reply) {
    hostRunOnWorker(^{ sp_host_callback_document_read((uintptr_t)context, (char *)reply); });
}

void documentRead(void *document, const char *path, int ref, bool granted, uintptr_t context) {
    hostRunOnMain(^{ sp_document_read(document, path, ref, granted, documentReadBridge, (void *)context); });
}

void documentScrollTo(void *document, double x, double y, uintptr_t context) {
    hostRunOnMain(^{ sp_document_scroll_to(document, x, y, documentScrolledBridge, (void *)context); });
}

void documentQuery(void *document, uintptr_t context) {
    hostRunOnMain(^{ sp_document_query(document, documentQueriedBridge, (void *)context); });
}

void *documentCreate(void *surface, const char *store, const char *package, const char *plugin, const char *label, const char *channel, uintptr_t context) {
    return ON_MAIN(void *, sp_document_create(surface, store, package, plugin, label, channel, documentChangedBridge, (void *)context));
}
void documentSetMessage(void *document, uintptr_t context) {
    hostRunOnMain(^{ sp_document_set_message(document, documentMessageBridge, (void *)context); });
}
void documentSetViewMessage(void *document, uintptr_t context) {
    hostRunOnMain(^{ sp_document_set_view_message(document, viewMessageBridge, (void *)context); });
}
void documentSetViewEnded(void *document, uintptr_t context) {
    hostRunOnMain(^{ sp_document_set_view_ended(document, viewEndedBridge, (void *)context); });
}
static void viewResponsivenessBridge(void *context, bool responsive) {
    hostRunOnWorker(^{ sp_host_callback_view_responsiveness((uintptr_t)context, responsive); });
}
const char *documentBinaryTake(void *document, const char *id, void **bytes, size_t *length) {
    return ON_MAIN(const char *, sp_document_binary_take(document, id, bytes, length));
}
char *documentBinaryPut(void *document, const void *bytes, size_t length, const char *type, char *id) {
    return ON_MAIN(char *, sp_document_binary_put(document, bytes, length, type, id));
}
void documentAddScript(void *document, const char *source) {
    hostRunOnMain(^{ sp_document_add_user_script(document, source); });
}
void documentSetViewResponsiveness(void *document, uintptr_t context) {
    hostRunOnMain(^{ sp_document_set_view_responsiveness(document, viewResponsivenessBridge, (void *)context); });
}
void documentSetEvent(void *document, uintptr_t context) {
    hostRunOnMain(^{ sp_document_set_event(document, documentEventBridge, (void *)context); });
}
void documentSetStream(void *document, uintptr_t context) {
    hostRunOnMain(^{ sp_document_set_stream(document, documentStreamBridge, (void *)context); });
}
void main_sp_view_import_map_set(const char *map) { hostRunOnMain(^{ sp_view_import_map_set(map); }); }
const char *main_sp_document_last_error(void) { return ON_MAIN(const char *, sp_document_last_error()); }
void main_sp_document_fail_creation_for_test(const char *cause) {
    hostRunOnMain(^{ sp_document_fail_creation_for_test(cause); });
}
bool main_sp_document_load(void *document, const char *url) { return ON_MAIN(bool, sp_document_load(document, url)); }
bool main_sp_document_zoom(void *document, double zoom) { return ON_MAIN(bool, sp_document_zoom(document, zoom)); }
bool main_sp_document_stream_on(void *document, const char *stream, bool on) {
    return ON_MAIN(bool, sp_document_stream_on(document, stream, on));
}
bool main_sp_document_stream_ack(void *document, unsigned long long seq) {
    return ON_MAIN(bool, sp_document_stream_ack(document, seq));
}
bool main_sp_document_post(void *document, const char *json) { return ON_MAIN(bool, sp_document_post(document, json)); }
bool main_sp_document_go(void *document, int action, int offset) {
    return ON_MAIN(bool, sp_document_go(document, action, offset));
}
char *main_sp_document_interaction_state(void *document) {
    return ON_MAIN(char *, sp_document_interaction_state(document));
}
const char *main_sp_document_restore(void *document, const char *state) {
    return ON_MAIN(const char *, sp_document_restore(document, state));
}
void main_sp_document_place(void *document, double left, double top, double right, double bottom, bool visible) {
    hostRunOnMain(^{ sp_document_place(document, left, top, right, bottom, visible); });
}
void main_sp_document_background(void *document, bool enabled) {
    hostRunOnMain(^{ sp_document_background(document, enabled); });
}
void main_sp_document_appearance(void *document, bool dark) {
    hostRunOnMain(^{ sp_document_appearance(document, dark); });
}
void main_sp_document_close(void *document) { hostRunOnMain(^{ sp_document_close(document); }); }
