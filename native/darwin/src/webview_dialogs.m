#import "webview_dialogs.h"

void sp_webview_route_dialogs(WKWebView *view) { (void)view; }

void *sp_window_hold_dialogs(void *window, SPDialogRequested requested) {
    (void)requested;
    return window;
}

void sp_window_release_dialogs(void *hold) { (void)hold; }

void sp_dialog_answer(uint64_t request, const char *const *paths, size_t count, bool cancel, SPDialogAnswered answered) {
    (void)request; (void)paths; (void)count; (void)cancel;
    answered("no request");
}

void sp_dialogs_set_download_folder(const char *folder) { (void)folder; }
