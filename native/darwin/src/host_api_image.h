#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host binding entry points. Window and callback tokens retain their uintptr_t representation.
void *imageCreate(void *surface, const char *name, uintptr_t context, uintptr_t lease);
void main_sp_region_place(void *region, double left, double top, double right, double bottom, bool visible);
bool main_sp_region_raster(void *region, double *out);
bool main_sp_region_surface_placed(void *region);
bool main_sp_region_present(void *region, unsigned int token_id, const unsigned char *nonce, double width, double height,
    double scale, uint64_t generation, uint64_t raster, int sequence);
char *main_sp_region_last_error(void *region);
void main_sp_region_focus(void *region);
void main_sp_region_caret(void *region, double x, double y, double w, double h);
void main_sp_region_text(void *region, const char *utf8);
void main_sp_region_background(void *region, bool enabled);
const char *main_sp_region_facts(void *region);
void main_sp_region_close(void *region);
