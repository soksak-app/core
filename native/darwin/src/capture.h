// 창 녹화. 프레임은 지정한 디렉터리에 frame-NNNN.bgra 파일로 기록한다. 파일은 너비, 높이, 한 줄의
// 바이트 수(uint32 셋), 창이 그려진 사각형 x, y, 너비, 높이(버퍼 포인트), 콘텐츠 배율, 배율, 표시
// 시각(ms)(float64 일곱), BGRA 픽셀 순서다.
#include <stdbool.h>
// display 이면 창이 있는 디스플레이에서 이 앱의 창을 녹화한다. 창이 다른 Space(전체 화면)로
// 옮겨지면 창 녹화는 멈추지만 디스플레이 녹화는 그 Space 를 계속 녹화한다.
void sp_capture_open(long windowNumber, bool display);
void sp_capture_start(const char *directory);
int sp_capture_wait(void);
int sp_capture_stop(void);
// 마지막으로 멈춘 녹화에서 연속한 완성 프레임 사이의 가장 긴 표시 간격(ms). 이보다 긴 간격에는
// 기록되지 않은 화면이 있다.
double sp_capture_longest_gap(void);
