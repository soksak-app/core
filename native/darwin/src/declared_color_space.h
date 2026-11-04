#import <CoreFoundation/CoreFoundation.h>
#import <CoreGraphics/CoreGraphics.h>

// Creates the color space that the kIOSurfaceColorSpace property of a frame declares
// (docs/spec/native-surfaces.md#image-regions). CoreGraphics stores a named space as its name string or as a number, and
// another space as a CFData or a CFDictionary, and it stops the process on a value of a type that it does not decode, so
// each type is checked before a decode. A CFData or a CFDictionary is decoded as a property list; a CFString is the name of
// a space; a CFNumber declares a space only when it equals the property list of a named space. Returns the color space,
// which the caller releases, or NULL with *error set to a text that names the property and the type of the value, which
// the caller releases.
CGColorSpaceRef sp_declared_color_space_create(CFTypeRef declaration, CFStringRef *error);
