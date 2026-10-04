#include <stdbool.h>

// 창 단추 세 개가 보이는 영역을 콘텐츠 왼쪽 위 기준 {x, y, width, height} 로 out 에 쓴다.
void windowControls(void *window, double *out);

// 창의 제목줄 높이(pt)를 반환한다. 전체 화면처럼 제목줄을 보이지 않는 동안 0 이고, 표준 단추나 콘텐츠 뷰가
// 없어 제목줄을 가질 수 없는 창은 -1 이다.
double windowTitlebarHeight(void *window);

// 창의 제목줄을 height(pt)로 만든다. AppKit 이 그 높이의 세로 가운데에 창 단추를 두므로 단추를 옮기지
// 않는다. height 가 양의 유한수가 아니거나 창이 제목줄을 가질 수 없으면 false 를 반환하고 failure 에 malloc 한
// 문장을 쓴다. 호출자가 해제한다. 전체 화면인 창은 제목줄을 보이지 않고 AppKit 이 나올 때 들어갈 때의 높이를
// 되돌리므로, 높이를 바꾸지 않고 true 를 반환한다.
bool windowSetTitlebarHeight(void *window, double height, char **failure);
