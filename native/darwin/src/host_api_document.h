#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host binding entry points. Window and callback tokens retain their uintptr_t representation.
void coreRootSet(uintptr_t context);
void documentQuery(void *document, uintptr_t context);
void *documentCreate(void *surface, const char *store, const char *package, const char *plugin, const char *label, const char *channel, uintptr_t context);
void documentSetMessage(void *document, uintptr_t context);
void documentSetViewMessage(void *document, uintptr_t context);
void documentSetViewEnded(void *document, uintptr_t context);
const char *documentBinaryTake(void *document, const char *id, void **bytes, size_t *length);
char *documentBinaryPut(void *document, const void *bytes, size_t length, const char *type, char *id);
void documentAddScript(void *document, const char *source);
void documentSetViewResponsiveness(void *document, uintptr_t context);
void documentSetEvent(void *document, uintptr_t context);
void documentSetStream(void *document, uintptr_t context);
void documentScrollTo(void *document, double x, double y, uintptr_t context);
void documentRead(void *document, const char *path, int ref, uintptr_t context);
void main_sp_view_import_map_set(const char *map);
const char *main_sp_document_last_error(void);
void main_sp_document_fail_creation_for_test(const char *cause);
bool main_sp_document_load(void *document, const char *url);
bool main_sp_document_zoom(void *document, double zoom);
bool main_sp_document_stream_on(void *document, const char *stream, bool on);
bool main_sp_document_stream_ack(void *document, unsigned long long seq);
bool main_sp_document_post(void *document, const char *json);
bool main_sp_document_go(void *document, int action, int offset);
char *main_sp_document_interaction_state(void *document);
const char *main_sp_document_restore(void *document, const char *state);
void main_sp_document_place(void *document, double left, double top, double right, double bottom, bool visible);
void main_sp_document_background(void *document, bool enabled);
void main_sp_document_appearance(void *document, bool dark);
void main_sp_document_close(void *document);
