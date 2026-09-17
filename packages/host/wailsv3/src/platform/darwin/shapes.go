//go:build darwin

package darwin

/*
#import <Cocoa/Cocoa.h>

// AppKit 좌표의 영역을 백킹 스토어의 픽셀 격자에 안쪽으로 맞춘다. 뷰는 페이지가
// 선언한 영역보다 넓게 덮지 않는다.
//
// 바깥쪽으로 맞추면 틀린다. 페이지의 선은 두 카드 사이의 통로에 있고, 통로 폭이 선
// 하나이면 두 표면이 양쪽에서 반 픽셀 떨어져 있다. 바깥쪽으로 키우면 두 표면이 선을
// 덮어 페이지의 초점 표시가 사라진다.
//
// 안쪽으로 맞추면 각 가장자리에 최대 반 픽셀의 카드 배경이 남는다. 그 배경은 표면
// 뒤에 원래 있는 것이다.
static NSRect surfaceAligned(NSWindow* window, double x, double y, double w, double h) {
    return [window backingAlignedRect:NSMakeRect(x, y, w, h) options:NSAlignAllEdgesInward];
}

// 도형 뷰를 디스플레이 픽셀에 맞춰 옮겨 가장자리를 선명하게 유지한다. 영역은 페이지가
// 선언한 대로 콘텐츠 뷰의 왼쪽 위에서 잰 페이지 좌표다.
static void shapeSetFrame(void* handle, double x, double y, double w, double h) {
    NSView* view = (NSView*)handle;
    NSWindow* window = [view window];
    if (window == nil || [window contentView] == nil) return;
    double up = [window contentView].bounds.size.height - y - h;
    view.frame = surfaceAligned(window, x, up, w, h);
}

// 도형을 형제 뷰들 위로 올린다.
static void surfaceRaise(void* handle) {
    NSView* view = (NSView*)handle;
    NSView* parent = [view superview];
    if (parent == nil) return;
    [parent addSubview:view positioned:NSWindowAbove relativeTo:nil];
}

// 페이지가 표면 위에 그리는 도형에 쓰는 레이어 기반 NSView 를 만든다. 레이어가 있는
// NSView 는 알파가 있는 색을 받아 뒤의 내용 위에 합성한다. WKWebView 는 WebKit 이 불투명
// 배경을 그리고 그 배경을 끄는 키가 비공개이므로 이 합성을 할 수 없다.
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

// 도형 뷰를 제거하고 alloc 이 반환한 참조를 해제한다. 상위 뷰는 removeFromSuperview
// 까지 자기 참조를 따로 갖는다.
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
