#ifndef SOKSAK_FRAME_H
#define SOKSAK_FRAME_H

#include <stdint.h>
#include <string.h>

typedef struct {
    uint32_t width;
    uint32_t height;
    uint32_t cell_width;
    uint32_t cell_height;
    double font_size;
} Metrics;

typedef struct {
    uint32_t col;
    uint32_t row;
    uint32_t width;
    const uint8_t *ch;
    uint32_t ch_len;
    uint8_t fg[3];
    uint8_t bg[3];
    uint8_t has_fg;
    uint8_t has_bg;
    uint8_t inverse;
} Cell;

typedef struct {
    uint32_t width;
    uint32_t height;
    uint32_t cursor_col;
    uint32_t cursor_row;
    Cell *cells;
    uint32_t cell_count;
    uint8_t cursor_visible;
    uint8_t cursor_focused;
    uint8_t cursor_blink_visible;
    uint8_t cursor_shape; // 0 블록, 1 밑줄, 2 빔
    uint8_t default_foreground[3];
    uint8_t default_background[3];
    uint8_t default_cursor[3];
} Screen;

typedef struct {
    const uint8_t *data;
    uint32_t data_len;
    uint32_t x;
    uint32_t y;
    uint32_t width;
    uint32_t height;
    uint8_t preserve_aspect_ratio;
} InlineImageRaster;

// Opaque Frame type - defined in implementation
struct Frame;
typedef struct Frame Frame;

// Create a frame with given pixel dimensions
// Returns NULL on failure
Frame* frame_new(uint32_t width_px, uint32_t height_px);

// Get the IOSurface ID (u32)
uint32_t frame_id(Frame *frame);

// Get the 16-byte nonce
// buf must be at least 16 bytes
void frame_nonce(Frame *frame, uint8_t *buf);

// Draw the screen to the frame's IOSurface
// Returns 0 on success, -1 on failure
int frame_draw(Frame *frame, Screen *screen, Metrics *metrics);
int frame_draw_with_inline_images(Frame *frame, Screen *screen, Metrics *metrics,
                                  InlineImageRaster *images, uint32_t image_count);

// Free the frame and release IOSurface
void frame_drop(Frame *frame);

// Calculate metrics for a given font size and scale
// font_size is in points (e.g., 13.0)
// scale is typically 1.0 or 2.0
Metrics frame_metrics(double font_size, double scale);

// Read a pixel at (x, y) and return BGRA values
// out must be at least 4 bytes
// Returns 0 on success, -1 on failure
int frame_pixel(Frame *frame, uint32_t x, uint32_t y, uint8_t *out);

#endif // SOKSAK_FRAME_H
