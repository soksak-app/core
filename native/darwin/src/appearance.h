#include <stdbool.h>

// 요청한 이름의 appearance 를 WebKit 뷰에 적용한다.
// 뷰나 이름의 appearance 를 사용할 수 없으면 false 를 반환한다.
bool sp_webview_set_appearance(void *view, bool dark);
