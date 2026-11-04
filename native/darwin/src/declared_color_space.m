#import <Foundation/Foundation.h>
#import "declared_color_space.h"

// The property lists of the named color spaces, each with its name. The names are the kCGColorSpace* constants of
// CoreGraphics/CGColorSpace.h of the SDK that are available at the deployment target and not deprecated there;
// kCGColorSpaceCoreMedia709, which macOS 15 adds, is taken when that system runs. The list is built once.
static CFArrayRef namedColorSpaces(void) {
    static CFArrayRef spaces = NULL;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSMutableArray *names = [NSMutableArray arrayWithObjects:
            (id)kCGColorSpaceGenericGray, (id)kCGColorSpaceGenericRGB, (id)kCGColorSpaceGenericCMYK,
            (id)kCGColorSpaceDisplayP3, (id)kCGColorSpaceGenericRGBLinear, (id)kCGColorSpaceAdobeRGB1998,
            (id)kCGColorSpaceSRGB, (id)kCGColorSpaceGenericGrayGamma2_2, (id)kCGColorSpaceGenericXYZ,
            (id)kCGColorSpaceGenericLab, (id)kCGColorSpaceACESCGLinear, (id)kCGColorSpaceITUR_709,
            (id)kCGColorSpaceITUR_709_PQ, (id)kCGColorSpaceITUR_709_HLG, (id)kCGColorSpaceITUR_2020,
            (id)kCGColorSpaceITUR_2020_sRGBGamma, (id)kCGColorSpaceROMMRGB, (id)kCGColorSpaceDCIP3,
            (id)kCGColorSpaceLinearITUR_2020, (id)kCGColorSpaceExtendedITUR_2020, (id)kCGColorSpaceExtendedLinearITUR_2020,
            (id)kCGColorSpaceLinearDisplayP3, (id)kCGColorSpaceExtendedDisplayP3, (id)kCGColorSpaceExtendedLinearDisplayP3,
            (id)kCGColorSpaceITUR_2100_PQ, (id)kCGColorSpaceITUR_2100_HLG, (id)kCGColorSpaceDisplayP3_PQ,
            (id)kCGColorSpaceDisplayP3_HLG, (id)kCGColorSpaceExtendedSRGB, (id)kCGColorSpaceLinearSRGB,
            (id)kCGColorSpaceExtendedLinearSRGB, (id)kCGColorSpaceExtendedGray, (id)kCGColorSpaceLinearGray,
            (id)kCGColorSpaceExtendedLinearGray, nil];
        if (@available(macOS 15.0, *)) [names addObject:(id)kCGColorSpaceCoreMedia709];
        NSMutableArray *list = [NSMutableArray arrayWithCapacity:names.count];
        for (NSString *name in names) {
            CGColorSpaceRef space = CGColorSpaceCreateWithName((CFStringRef)name);
            if (!space) continue;
            CFPropertyListRef properties = CGColorSpaceCopyPropertyList(space);
            CGColorSpaceRelease(space);
            if (!properties) continue;
            [list addObject:@[name, (id)properties]];
            CFRelease(properties);
        }
        spaces = (CFArrayRef)[list copy];
    });
    return spaces;
}

static CFStringRef copyDeclarationError(CFTypeID type, NSString *reason) {
    CFStringRef typeName = CFCopyTypeIDDescription(type);
    NSString *text = [NSString stringWithFormat:@"the kIOSurfaceColorSpace property of the frame is a %@ that %@",
        typeName ? (NSString *)typeName : [NSString stringWithFormat:@"value of type %lu", (unsigned long)type], reason];
    if (typeName) CFRelease(typeName);
    return (CFStringRef)[text copy];
}

CGColorSpaceRef sp_declared_color_space_create(CFTypeRef declaration, CFStringRef *error) {
    @autoreleasepool {
        CFTypeID type = CFGetTypeID(declaration);
        if (type == CFDataGetTypeID() || type == CFDictionaryGetTypeID()) {
            CGColorSpaceRef space = CGColorSpaceCreateWithPropertyList(declaration);
            if (!space) *error = copyDeclarationError(type, @"CoreGraphics decodes to no color space");
            return space;
        }
        if (type == CFStringGetTypeID()) {
            CGColorSpaceRef space = CGColorSpaceCreateWithName((CFStringRef)declaration);
            if (!space) *error = copyDeclarationError(type,
                [NSString stringWithFormat:@"names no color space: %@", (NSString *)declaration]);
            return space;
        }
        if (type == CFNumberGetTypeID()) {
            for (NSArray *named in (NSArray *)namedColorSpaces()) {
                if (!CFEqual(declaration, (CFTypeRef)named[1])) continue;
                CGColorSpaceRef space = CGColorSpaceCreateWithName((CFStringRef)named[0]);
                if (!space) *error = copyDeclarationError(type,
                    [NSString stringWithFormat:@"is the property list of %@, which CoreGraphics no longer creates", named[0]]);
                return space;
            }
            *error = copyDeclarationError(type,
                [NSString stringWithFormat:@"is the property list of no named color space: %@", (NSNumber *)declaration]);
            return NULL;
        }
        *error = copyDeclarationError(type, @"declares no color space");
        return NULL;
    }
}
