void webviewAttachSurface(void *webview, void *mainWebview);
#ifdef __OBJC__
@class NSEvent, NSView;
// 표면 좌표계 안의 뷰는 좌표 한 단위가 장치 픽셀 하나다. WebKit 은 휠 이동량(포인트)을 뷰 좌표
// 단위로 쓰므로, view 로 가는 휠 이벤트를 그 단위로 바꾼 이벤트를 반환한다. 표면 좌표계 밖이면 event 다.
NSEvent *webviewScrollInViewUnits(NSEvent *event, NSView *view);
#endif
// 표면 웹뷰 안에 둔 웹뷰가 표면과 같은 단위로 그리게 한다.
void webviewMatchSurface(void *webview, void *surface);
void webviewSetFrame(void *webview, double x, double y, double width, double height);
void webviewGetFrame(void *webview, double *rect);
