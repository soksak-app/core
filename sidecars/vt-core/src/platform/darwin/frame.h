#ifndef SOKSAK_FRAME_H
#define SOKSAK_FRAME_H

#include <stdint.h>
#include <string.h>

// 터미널 글꼴. 번들 글꼴 데이터나 설치된 글꼴 이름으로 만든다.
struct FrameFont;
typedef struct FrameFont FrameFont;

typedef struct {
    uint32_t width;
    uint32_t height;
    uint32_t cell_width;
    uint32_t cell_height;
    double font_size;
    const FrameFont *font; // 셀 메트릭을 계산하고 글자를 그리는 글꼴
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
    uint32_t cursor_width; // 커서 위치 글자가 차지하는 칸 수. 넓은 글자는 2 다.
} Screen;

typedef struct {
    const uint8_t *data;
    uint32_t data_len;
    uint32_t x;
    uint32_t y;
    uint32_t width;
    uint32_t height;
    uint8_t preserve_aspect_ratio;
    uint8_t visible;
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

// 글꼴 데이터(TrueType 등)로 글꼴을 만든다. 데이터가 글꼴이 아니면 NULL 을 반환한다.
FrameFont *frame_font_from_data(const uint8_t *data, uint32_t length);
// 설치된 글꼴 가운데 family 이름이 정확히 같은 글꼴을 만든다. 없으면 NULL 을 반환한다.
FrameFont *frame_font_named(const char *family);
void frame_font_drop(FrameFont *font);
// 글꼴의 family 이름을 malloc 한 UTF-8 문자열로 반환한다. 호출자가 free 한다.
char *frame_font_family(const FrameFont *font);

// font 의 font_size(pt) 와 scale 로 셀 메트릭을 계산한다. 셀 폭은 'M' 의 advance 다.
Metrics frame_metrics(const FrameFont *font, double font_size, double scale);

// Read a pixel at (x, y) and return BGRA values
// out must be at least 4 bytes
// Returns 0 on success, -1 on failure
int frame_pixel(Frame *frame, uint32_t x, uint32_t y, uint8_t *out);

#endif // SOKSAK_FRAME_H
