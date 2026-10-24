#ifndef SOKSAK_IMAGE_CAPTURE_MATCH_H
#define SOKSAK_IMAGE_CAPTURE_MATCH_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <CoreGraphics/CoreGraphics.h>
#include <CoreVideo/CoreVideo.h>
#include <dispatch/dispatch.h>

typedef struct {
    uint64_t generation;
    uint64_t raster;
    int sequence;
} sp_image_capture_identity;

typedef enum {
    SP_IMAGE_CAPTURE_MATCHED,
    SP_IMAGE_CAPTURE_AMBIGUOUS,
    SP_IMAGE_CAPTURE_UNMATCHED,
    SP_IMAGE_CAPTURE_UNKNOWN_GEOMETRY,
    SP_IMAGE_CAPTURE_UNKNOWN_SCALE,
    SP_IMAGE_CAPTURE_UNKNOWN_COLOR,
    SP_IMAGE_CAPTURE_UNKNOWN_RETENTION
} sp_image_capture_match_state;

typedef struct {
    sp_image_capture_match_state state;
    sp_image_capture_identity *candidates;
    size_t candidate_count;
    size_t dropped_snapshots;
    uint64_t display_time;
    bool has_latest_source;
    sp_image_capture_identity latest_source;
    size_t latest_width;
    size_t latest_height;
    size_t latest_stride;
    CGRect latest_screen_bounds;
    double latest_scale;
    char latest_color_space[128];
    bool has_latest_crop;
    CGRect latest_crop;
    bool has_pixel_difference;
    size_t different_pixels;
    size_t first_difference_x;
    size_t first_difference_y;
    uint8_t expected_bgra[4];
    uint8_t actual_bgra[4];
} sp_image_capture_match_result;

// Starts a diagnostic-only source history. The history has a fixed 64 MiB byte bound.
void sp_image_capture_match_begin(void);
// Queues each source identity not yet represented by an artifact on the capture's existing serial writer queue.
void sp_image_capture_match_write_sources(const char *capture_directory, dispatch_queue_t writer_queue);
// Writes the bounded source manifest after the writer queue has drained. Returns false on an artifact or manifest I/O error.
bool sp_image_capture_match_write_manifest(const char *capture_directory);
// Stops source retention and releases every retained diagnostic copy.
void sp_image_capture_match_end(void);
// Does not allocate or lock; false means image presentation retains no diagnostic copy.
bool sp_image_capture_match_active(void);
// Records a source snapshot that diagnostics could not copy or retain.
void sp_image_capture_match_drop(void);
// Retains immutable source pixels only while matching diagnostics are active. Returns false and increments the
// observable drop count when a source raster cannot fit the bounded history.
bool sp_image_capture_match_retain(sp_image_capture_identity identity, const uint8_t *pixels,
    size_t width, size_t height, size_t stride, CGRect screen_bounds, double scale, const char *color_space);
// Maps each retained source screen bound into the sample's contentRect using screenRect and the declared scales,
// then compares the corresponding BGRA crop exactly. Missing or out-of-bounds mapping metadata is explicit unknown.
sp_image_capture_match_result sp_image_capture_match_sample(const uint8_t *pixels,
    size_t frame_width, size_t frame_height, size_t frame_stride, CGRect content_rect, CGRect screen_rect,
    double content_scale, double scale_factor, const char *color_space, uint64_t display_time);
const char *sp_image_capture_match_state_name(sp_image_capture_match_state state);
void sp_image_capture_match_result_dispose(sp_image_capture_match_result *result);

#endif
