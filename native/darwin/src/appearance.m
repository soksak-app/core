#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

#import "appearance.h"
#import "application_log.h"

bool sp_webview_set_appearance(void *handle, bool dark) {
    if (!handle) {
        sp_log_error("appearance", "the web view handle is missing");
        return false;
    }
    NSAppearance *appearance = [NSAppearance appearanceNamed:(dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua)];
    if (!appearance) {
        sp_log_error("appearance", "the system has no appearance of the requested kind");
        return false;
    }
    ((WKWebView *)handle).appearance = appearance;
    return true;
}
