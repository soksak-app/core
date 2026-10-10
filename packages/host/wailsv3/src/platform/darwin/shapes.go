//go:build darwin

package darwin

/*
#import <Cocoa/Cocoa.h>

// Fits a region in AppKit coordinates inward to the pixel grid of the backing store. A view does not cover more than the region
// that the page declared.
//
// Fitting outward is wrong. The line of the page is in the passage between two cards, and when the passage width is one line,
// the two surfaces are half a pixel away on each side. If they were enlarged outward, the two surfaces would cover the line and the focus indicator
// of the page would disappear.
//
// Fitting inward leaves at most half a pixel of the card background at each edge. That background is originally behind
// the surface.
static NSRect surfaceAligned(NSWindow* window, double x, double y, double w, double h) {
    return [window backingAlignedRect:NSMakeRect(x, y, w, h) options:NSAlignAllEdgesInward];
}

// Moves the shape view to the display pixels to keep the edges sharp. The region is in page coordinates measured from the top left of the content view,
// as the page declared.
static void shapeSetFrame(void* handle, double x, double y, double w, double h) {
    NSView* view = (NSView*)handle;
    NSWindow* window = [view window];
    if (window == nil || [window contentView] == nil) return;
    double up = [window contentView].bounds.size.height - y - h;
    view.frame = surfaceAligned(window, x, up, w, h);
}

// Raises the shape above its sibling views.
static void surfaceRaise(void* handle) {
    NSView* view = (NSView*)handle;
    NSView* parent = [view superview];
    if (parent == nil) return;
    [parent addSubview:view positioned:NSWindowAbove relativeTo:nil];
}

// Creates the layer-backed NSView used for the shapes that the page draws over a surface. An NSView with a layer
// accepts a color with alpha and composites it over the content behind. WKWebView cannot do this composition because WebKit draws an opaque
// background and the key to turn that background off is private.
static void* shapeCreate(void* nsWindow, double x, double y, double w, double h) {
    NSWindow* window = (NSWindow*)nsWindow;
    if (window == nil || [window contentView] == nil) return NULL;
    double up = [window contentView].bounds.size.height - y - h;
    NSView* view = [[NSView alloc] initWithFrame:surfaceAligned(window, x, up, w, h)];
    [view setWantsLayer:YES];
    [[window contentView] addSubview:view positioned:NSWindowAbove relativeTo:nil];
    return (void*)view;
}

static void shapeSetStyle(void* handle, double radius, double lineWidth,
                          double fr, double fg, double fb, double fa,
                          double lr, double lg, double lb, double la) {
    NSView* view = (NSView*)handle;
    view.layer.cornerRadius = radius;
    view.layer.borderWidth = lineWidth;
    view.layer.backgroundColor =
        [[NSColor colorWithSRGBRed:fr green:fg blue:fb alpha:fa] CGColor];
    view.layer.borderColor =
        [[NSColor colorWithSRGBRed:lr green:lg blue:lb alpha:la] CGColor];
}

// Removes the shape view and releases the reference that alloc returned. The superview keeps its own reference until
// removeFromSuperview.
static void shapeDestroy(void* handle) {
    NSView* view = (NSView*)handle;
    [view removeFromSuperview];
    [view release];
}
*/
import "C"

import "unsafe"

func (implementation) CreateShape(window unsafe.Pointer, x, y, w, h float64) (unsafe.Pointer, error) {
	return C.shapeCreate(window, C.double(x), C.double(y), C.double(w), C.double(h)), nil
}

func (implementation) SetShapeFrame(shape unsafe.Pointer, x, y, w, h float64) {
	C.shapeSetFrame(shape, C.double(x), C.double(y), C.double(w), C.double(h))
}

func (implementation) SetShapeStyle(shape unsafe.Pointer, radius, lineWidth float64, fill, line [4]float64) {
	C.shapeSetStyle(shape, C.double(radius), C.double(lineWidth),
		C.double(fill[0]), C.double(fill[1]), C.double(fill[2]), C.double(fill[3]),
		C.double(line[0]), C.double(line[1]), C.double(line[2]), C.double(line[3]))
}

func (implementation) RaiseShape(shape unsafe.Pointer) { C.surfaceRaise(shape) }

func (implementation) DestroyShape(shape unsafe.Pointer) { C.shapeDestroy(shape) }
