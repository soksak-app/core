// The dialogs of the pages of a window (docs/spec/exposure.md#dialogs): the open panel of a file input and the destination of
// a download. While the host holds the dialogs of a window, each is a request that the host answers; otherwise the open panel
// is the panel of the framework, and a download goes where the framework puts it or, without one, into the download folder.
#pragma once
#import <WebKit/WebKit.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/// Receives a request of a held window: its number and its JSON `{kind, suggestedName, directory, multiple, directories,
/// url}`, kind `open` or `download`. It runs on the main thread.
typedef void (^SPDialogRequested)(uint64_t request, const char *json);

/// Receives the end of an answer: NULL when the answer was applied, which for a download is when the file was written, or
/// the reason it failed. It runs on the main thread.
typedef void (^SPDialogAnswered)(const char *error);

/// Routes the open panels and the downloads of view through the dialogs of its window. A web view of the application calls it
/// once, after its framework set its delegates; a second call does nothing. Main thread.
void sp_webview_route_dialogs(WKWebView *view);

/// Holds the dialogs of window: a request of a routed web view of the window shows no panel and goes to requested. It returns
/// the hold, which sp_window_release_dialogs ends, or NULL when the window already has one. Main thread.
void *sp_window_hold_dialogs(void *window, SPDialogRequested requested);

/// Ends a hold of sp_window_hold_dialogs: each request of it that waits for its answer is answered as cancelled. Main thread.
void sp_window_release_dialogs(void *hold);

/// Answers request with the count paths, or cancels it when cancel is true. An open receives the files; a download is
/// written to the one path, an existing file there is replaced, and answered runs when the download ended. answered runs once,
/// also for a request that waits no more. Main thread.
void sp_dialog_answer(uint64_t request, const char *const *paths, size_t count, bool cancel, SPDialogAnswered answered);

/// Sets the folder of the downloads of a web view whose framework places none. Without it they go into the folder of downloads
/// of the user, and a native check that downloads sets a folder of its own. Main thread.
void sp_dialogs_set_download_folder(const char *folder);
