#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

#import "appearance.h"

bool sp_webview_set_appearance(void *handle, bool dark) {
    if (!handle) return false;
    NSAppearance *appearance = [NSAppearance appearanceNamed:(dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua)];
    if (!appearance) return false;
    ((WKWebView *)handle).appearance = appearance;
    return true;
}
