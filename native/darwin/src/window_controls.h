#include <stdbool.h>

// 창 단추 세 개가 보이는 영역을 콘텐츠 왼쪽 위 기준 {x, y, width, height} 로 out 에 쓴다.
void windowControls(void *window, double *out);

// 창의 제목줄을 도구막대 높이로 만들고 그 높이(pt)를 반환한다. AppKit 이 그 높이의 세로 가운데에
// 창 단추를 두므로 단추를 옮기지 않는다. 페이지의 첫 행은 이 높이를 쓴다. 창에 표준 단추나
// 콘텐츠 뷰가 없으면 0 을 반환한다.
double windowUnifiedTitlebar(void *window);
