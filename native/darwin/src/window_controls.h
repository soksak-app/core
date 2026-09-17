#include <stdbool.h>

// 창 단추 세 개가 보이는 영역을 콘텐츠 왼쪽 위 기준 {x, y, width, height} 로 out 에 쓴다.
void windowControls(void *window, double *out);

// 창 단추를 콘텐츠 영역 안에 둔다. 맨 왼쪽 단추의 왼쪽 끝이 x 에, 단추가 보이는 영역의 세로
// 중앙이 centreY 에 온다(둘 다 콘텐츠 왼쪽 위 기준 포인트). 이후 AppKit 이 단추를 되찾거나
// 창 크기가 바뀌어도 같은 자리에 다시 둔다. 창에 표준 단추나 콘텐츠 뷰가 없으면 false 를 반환한다.
bool windowPlaceControls(void *window, double x, double centreY);
