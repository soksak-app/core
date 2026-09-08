#include <stdbool.h>
#include <stdint.h>

void nativeWindowPrepare(void *window);
bool nativeWindowAfterPresentation(void *window, uintptr_t callback);
void *nativeWebviewCreate(void *window, unsigned long long identifier, const char *script,
    double x, double y, double width, double height, bool hidden, bool transparent, bool fillParent);
bool nativeWebviewNavigate(void *view, const char *url);
void nativeWebviewBounds(void *view, double x, double y, double width, double height);
void nativeWebviewHidden(void *view, bool hidden);
void nativeWebviewBackground(void *view, bool enabled);
void nativeWebviewEval(void *view, const char *script);
void nativeWebviewClose(void *view);

void nativeWindowLayoutBegin(void *window, uint64_t ticket, uintptr_t callback);
