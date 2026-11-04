// Reads the presented frame of an image layer. An image region presents a host-owned IOSurface as the contents of its layer
// (docs/spec/native-surfaces.md#image-regions), so a check copies the bytes of that surface into a CGImage with the color space
// that the surface declares, which sp_declared_color_space_create reads, or DeviceRGB when it declares none. A frame that
// carries the opt-in diagnostic identity code is a CGImage, which is returned as it is. The image is autoreleased; NULL means
// the layer has no image, or a declaration that names no color space, whose error is written to the standard error.
#import <CoreGraphics/CoreGraphics.h>
#import <IOSurface/IOSurface.h>
#import <QuartzCore/QuartzCore.h>
#include <stdio.h>
#import "declared_color_space.h"

static inline CGImageRef layerContentsImage(CALayer *layer) {
    id contents = layer.contents;
    if (!contents) return NULL;
    if (CFGetTypeID((__bridge CFTypeRef)contents) == CGImageGetTypeID()) return (__bridge CGImageRef)contents;
    if (CFGetTypeID((__bridge CFTypeRef)contents) != IOSurfaceGetTypeID()) return NULL;
    IOSurfaceRef surface = (__bridge IOSurfaceRef)contents;
    if (IOSurfaceLock(surface, kIOSurfaceLockReadOnly, NULL) != kIOReturnSuccess) return NULL;
    size_t width = IOSurfaceGetWidth(surface);
    size_t height = IOSurfaceGetHeight(surface);
    size_t bytesPerRow = IOSurfaceGetBytesPerRow(surface);
    CFDataRef data = CFDataCreate(NULL, IOSurfaceGetBaseAddress(surface), bytesPerRow * height);
    IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);
    CFPropertyListRef colorProperties = IOSurfaceCopyValue(surface, kIOSurfaceColorSpace);
    CFStringRef error = NULL;
    CGColorSpaceRef colors = colorProperties ? sp_declared_color_space_create(colorProperties, &error) : CGColorSpaceCreateDeviceRGB();
    if (colorProperties) CFRelease(colorProperties);
    if (!colors) {
        fprintf(stderr, "layer contents: %s\n", error ? [(__bridge NSString *)error UTF8String] : "DeviceRGB could not be created");
        if (error) CFRelease(error);
        CFRelease(data);
        return NULL;
    }
    CGDataProviderRef provider = CGDataProviderCreateWithCFData(data);
    CGImageRef image = CGImageCreate(width, height, 8, 32, bytesPerRow, colors,
        kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst, provider, NULL, false, kCGRenderingIntentDefault);
    CGDataProviderRelease(provider);
    CGColorSpaceRelease(colors);
    CFRelease(data);
    return image ? (CGImageRef)CFAutorelease(image) : NULL;
}
