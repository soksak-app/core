#include <stdbool.h>

#ifdef __OBJC__
#import <WebKit/WebKit.h>

// 앱 DOM 웹뷰의 main frame 이 다른 문서로 바뀔 때마다 새 WebContent 프로세스에서 문서를 열고, 문서가 commit 되면
// 이전 문서를 멈춰 둔 back/forward cache 를 비워 이전 프로세스를 끝낸다. WebKit 은 같은 프로세스에서 교체한 문서를
// 문서별 querySelectorAll 결과 캐시 때문에 메모리 압박 전까지 남긴다. 프레임워크가 설정한 navigation delegate 를
// 감싸며, 그 delegate 는 모든 알림과 결정을 그대로 받는다. 같은 문서 안의 이동(fragment)은 프로세스를 바꾸지 않는다.
// 이미 감싼 웹뷰에는 다시 감싸지 않는다. 메인 스레드에서 호출한다. WebKit 이 필요한 비공개 선택자를 주지 않으면 false 다.
bool sp_webview_replace_documents_in_new_process(WKWebView *view);
#endif
