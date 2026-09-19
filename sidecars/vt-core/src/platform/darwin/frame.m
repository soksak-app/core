#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreText/CoreText.h>
#include "frame.h"
#include <stdio.h>
#include <string.h>

struct Frame {
    IOSurfaceRef surface;
    uint32_t surface_id;
    uint8_t nonce[16];
    uint32_t width;
    uint32_t height;
};

// Parse hex color string (#rrggbb format)
static CGColorRef parse_color(const char *hex_color) {
    if (!hex_color || hex_color[0] != '#' || strlen(hex_color) != 7) {
        return NULL;
    }

    unsigned int r, g, b;
    if (sscanf(hex_color + 1, "%02x%02x%02x", &r, &g, &b) == 3) {
        CGFloat red = r / 255.0;
        CGFloat green = g / 255.0;
        CGFloat blue = b / 255.0;
        return CGColorCreateSRGB(red, green, blue, 1.0);
    }
    return NULL;
}

// Create a frame with given pixel dimensions
Frame* frame_new(uint32_t width_px, uint32_t height_px) {
    Frame *frame = malloc(sizeof(Frame));
    if (!frame) return NULL;

    frame->width = width_px;
    frame->height = height_px;

    // Create global IOSurface
    // BGRA format code: 0x42475241
    NSDictionary *properties = @{
        (id)kIOSurfaceWidth: @(width_px),
        (id)kIOSurfaceHeight: @(height_px),
        (id)kIOSurfacePixelFormat: @(0x42475241),  // 'BGRA'
        (id)kIOSurfaceBytesPerElement: @4,
// kIOSurfaceIsGlobal is deprecated but required by design
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        (id)kIOSurfaceIsGlobal: @YES,
#pragma clang diagnostic pop
    };

    frame->surface = IOSurfaceCreate((CFDictionaryRef)properties);
    if (!frame->surface) {
        free(frame);
        return NULL;
    }

    frame->surface_id = IOSurfaceGetID(frame->surface);

    // Attach sRGB color space to surface
    CGColorSpaceRef srgb_space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    if (srgb_space) {
        CFPropertyListRef color_space_plist = CGColorSpaceCopyPropertyList(srgb_space);
        if (color_space_plist) {
            IOSurfaceSetValue(frame->surface, kIOSurfaceColorSpace, color_space_plist);
            CFRelease(color_space_plist);
        }
        CGColorSpaceRelease(srgb_space);
    }

    // Generate 16-byte nonce
    arc4random_buf(frame->nonce, 16);

    // Set nonce as property on surface
    NSData *nonce_data = [NSData dataWithBytes:frame->nonce length:16];
    IOSurfaceSetValue(frame->surface, CFSTR("soksak.frame"), (CFDataRef)nonce_data);

    return frame;
}

uint32_t frame_id(Frame *frame) {
    if (!frame) return 0;
    return frame->surface_id;
}

void frame_nonce(Frame *frame, uint8_t *buf) {
    if (frame && buf) {
        memcpy(buf, frame->nonce, 16);
    }
}

int frame_draw(Frame *frame, Screen *screen, Metrics *metrics) {
    if (!frame || !screen || !metrics) return -1;

    // Lock the surface
    IOSurfaceLock(frame->surface, 0, NULL);

    // Get the surface data
    void *base_address = IOSurfaceGetBaseAddress(frame->surface);
    if (!base_address) {
        IOSurfaceUnlock(frame->surface, 0, NULL);
        return -1;
    }

    size_t bytes_per_row = IOSurfaceGetBytesPerRow(frame->surface);

    // Create sRGB color space
    CGColorSpaceRef color_space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    if (!color_space) {
        IOSurfaceUnlock(frame->surface, 0, NULL);
        return -1;
    }

    // Create bitmap context for BGRA8 with sRGB
    CGContextRef ctx = CGBitmapContextCreateWithData(
        base_address,
        frame->width, frame->height,
        8,  // bits per component
        bytes_per_row,
        color_space,
        kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little,
        NULL,  // release callback
        NULL   // release callback info
    );
    CGColorSpaceRelease(color_space);

    if (!ctx) {
        IOSurfaceUnlock(frame->surface, 0, NULL);
        return -1;
    }

    // Set up font with the same size used in frame_metrics
    CTFontRef font = CTFontCreateWithName(CFSTR("Menlo"), metrics->font_size, NULL);
    if (!font) {
        CGContextRelease(ctx);
        IOSurfaceUnlock(frame->surface, 0, NULL);
        return -1;
    }

    // Default colors - use sRGB
    CGColorRef default_fg_color = CGColorCreateSRGB(208/255.0, 208/255.0, 208/255.0, 1.0); // #d0d0d0
    CGColorRef default_bg_color = CGColorCreateSRGB(30/255.0, 30/255.0, 30/255.0, 1.0);   // #1e1e1e

    // Fill entire background with CGContextFillRect
    CGContextSetFillColorWithColor(ctx, default_bg_color);
    CGContextFillRect(ctx, CGRectMake(0, 0, (CGFloat)frame->width, (CGFloat)frame->height));

    // Draw cells
    for (uint32_t i = 0; i < screen->cell_count; i++) {
        Cell *cell = &screen->cells[i];

        // Calculate cell position (CoreGraphics origin is bottom-left, convert to top-left coordinates)
        // In a bottom-origin system: y = frame_height - (row+1) * cell_height places row 0 at top
        CGFloat x = cell->col * metrics->cell_width;
        CGFloat content_height = screen->height * metrics->cell_height;
        CGFloat y = (CGFloat)frame->height - content_height + cell->row * metrics->cell_height;

        // Get colors
        CGColorRef bg_color = NULL;
        CGColorRef fg_color = NULL;
        int parsed_bg = 0;
        int parsed_fg = 0;

        if (cell->has_bg) {
            char hex_buf[8];
            snprintf(hex_buf, sizeof(hex_buf), "#%02x%02x%02x", cell->bg[0], cell->bg[1], cell->bg[2]);
            bg_color = parse_color(hex_buf);
            if (bg_color) parsed_bg = 1;
        }
        if (cell->has_fg) {
            char hex_buf[8];
            snprintf(hex_buf, sizeof(hex_buf), "#%02x%02x%02x", cell->fg[0], cell->fg[1], cell->fg[2]);
            fg_color = parse_color(hex_buf);
            if (fg_color) parsed_fg = 1;
        }

        if (!bg_color) bg_color = default_bg_color;
        if (!fg_color) fg_color = default_fg_color;

        // Handle inverse video
        if (cell->inverse) {
            CGColorRef tmp = bg_color;
            bg_color = fg_color;
            fg_color = tmp;
        }

        // Draw background
        CGContextSetFillColorWithColor(ctx, bg_color);
        CGContextFillRect(ctx, CGRectMake(x, y, metrics->cell_width * cell->width, metrics->cell_height));

        // Draw character if present
        if (cell->ch_len > 0 && cell->width > 0) {
            NSString *ch = [[NSString alloc] initWithBytes:cell->ch length:cell->ch_len encoding:NSUTF8StringEncoding];
            if (ch) {
                CFStringRef cf_str = (__bridge CFStringRef)ch;

                // Create attributes dictionary with font and foreground color
                CGFloat descent = CTFontGetDescent(font);
                NSDictionary *attrs = @{
                    (id)kCTFontAttributeName: (__bridge id)font,
                    (id)kCTForegroundColorAttributeName: (__bridge id)fg_color
                };
                CFAttributedStringRef attr_str = CFAttributedStringCreate(NULL, cf_str, (__bridge CFDictionaryRef)attrs);

                if (attr_str) {
                    CTLineRef line = CTLineCreateWithAttributedString(attr_str);
                    if (line) {
                        CGContextSetTextPosition(ctx, x, y + descent);
                        CTLineDraw(line, ctx);
                        CFRelease(line);
                    }
                    CFRelease(attr_str);
                }
            }
        }

        if (parsed_bg) CGColorRelease(bg_color);
        if (parsed_fg) CGColorRelease(fg_color);
    }

    CFRelease(font);
    CGContextRelease(ctx);
    CGColorRelease(default_fg_color);
    CGColorRelease(default_bg_color);

    IOSurfaceUnlock(frame->surface, 0, NULL);

    return 0;
}

void frame_drop(Frame *frame) {
    if (frame) {
        if (frame->surface) {
            CFRelease(frame->surface);
        }
        free(frame);
    }
}

Metrics frame_metrics(double font_size, double scale) {
    Metrics metrics = {0};

    // Create a temporary font to measure
    double scaled_font_size = font_size * scale;
    CTFontRef font = CTFontCreateWithName(CFSTR("Menlo"), scaled_font_size, NULL);

    // Measure 'M' for width
    UniChar char_m = 'M';
    CGSize advances;
    CTFontGetAdvancesForGlyphs(font, kCTFontOrientationHorizontal, &char_m, &advances, 1);
    metrics.cell_width = (uint32_t)ceil(advances.width);

    // Measure height from ascent + descent + leading
    CGFloat ascent = CTFontGetAscent(font);
    CGFloat descent = CTFontGetDescent(font);
    CGFloat leading = CTFontGetLeading(font);
    metrics.cell_height = (uint32_t)ceil(ascent + descent + leading);

    // Store the scaled font size for use in frame_draw
    metrics.font_size = scaled_font_size;

    CFRelease(font);

    return metrics;
}

// Read a pixel at (x, y) from the IOSurface and store BGRA values in out
// out must be at least 4 bytes
// Returns 0 on success, -1 on failure
int frame_pixel(Frame *frame, uint32_t x, uint32_t y, uint8_t *out) {
    if (!frame || !frame->surface || !out) return -1;
    if (x >= frame->width || y >= frame->height) return -1;

    IOSurfaceLock(frame->surface, kIOSurfaceLockReadOnly, NULL);

    void *base_address = IOSurfaceGetBaseAddress(frame->surface);
    if (!base_address) {
        IOSurfaceUnlock(frame->surface, kIOSurfaceLockReadOnly, NULL);
        return -1;
    }

    size_t bytes_per_row = IOSurfaceGetBytesPerRow(frame->surface);
    uint8_t *pixel_ptr = (uint8_t *)base_address + (y * bytes_per_row) + (x * 4);

    // BGRA format: B, G, R, A
    out[0] = pixel_ptr[0];  // B
    out[1] = pixel_ptr[1];  // G
    out[2] = pixel_ptr[2];  // R
    out[3] = pixel_ptr[3];  // A

    IOSurfaceUnlock(frame->surface, kIOSurfaceLockReadOnly, NULL);

    return 0;
}
