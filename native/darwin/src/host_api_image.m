// Native implementation of the host binding helpers formerly owned by image.go.
#include "host_api_image.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include "image_region.h"
#include "main_thread.h"
#include "host_callbacks.h"

// The callback runs its Go function on the worker, and the native calls of this file run on the main thread (main_thread.h).

static void imageChangedBridge(void *context, const char *json) {
    hostRunOnWorker(^{ sp_host_callback_image_changed((uintptr_t)context, (char *)json); });
}


static void imageReleasedBridge(void *context, uint64_t generation, uint64_t raster, int sequence) {
    hostRunOnWorker(^{ sp_host_callback_image_released((uintptr_t)context, generation, raster, sequence); });
}

// A nonzero lease puts the region in the lease mode with that receiver of its released surfaces.
void *imageCreate(void *surface, const char *name, uintptr_t context, uintptr_t lease) {
    return ON_MAIN(void *, ({
        void *region = sp_region_create(surface, name, imageChangedBridge, (void *)context);
        if (region && lease) sp_region_lease(region, imageReleasedBridge, (void *)lease);
        region;
    }));
}
void main_sp_region_place(void *region, double left, double top, double right, double bottom, bool visible) {
    hostRunOnMain(^{ sp_region_place(region, left, top, right, bottom, visible); });
}
bool main_sp_region_raster(void *region, double *out) { return ON_MAIN(bool, sp_region_raster(region, out)); }
bool main_sp_region_surface_placed(void *region) { return ON_MAIN(bool, sp_region_surface_placed(region)); }
bool main_sp_region_present(void *region, unsigned int token_id, const unsigned char *nonce, double width, double height,
    double scale, uint64_t generation, uint64_t raster, int sequence) {
    return ON_MAIN(bool, sp_region_present(region, token_id, nonce, width, height, scale, generation, raster, sequence));
}
char *main_sp_region_last_error(void *region) { return ON_MAIN(char *, sp_region_last_error(region)); }
void main_sp_region_focus(void *region) { hostRunOnMain(^{ sp_region_focus(region); }); }
void main_sp_region_caret(void *region, double x, double y, double w, double h) {
    hostRunOnMain(^{ sp_region_caret(region, x, y, w, h); });
}
void main_sp_region_text(void *region, const char *utf8) { hostRunOnMain(^{ sp_region_text(region, utf8); }); }
void main_sp_region_background(void *region, bool enabled) { hostRunOnMain(^{ sp_region_background(region, enabled); }); }
const char *main_sp_region_facts(void *region) { return ON_MAIN(const char *, sp_region_facts(region)); }
void main_sp_region_close(void *region) { hostRunOnMain(^{ sp_region_close(region); }); }
