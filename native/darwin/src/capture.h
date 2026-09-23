// 창 녹화. 프레임은 지정한 디렉터리에 frame-NNNN.bgra 파일로 기록한다. 파일은 너비, 높이, 한 줄의
// 바이트 수(uint32 셋), 창이 그려진 사각형 x, y, 너비, 높이(버퍼 포인트), 콘텐츠 배율, 배율, 표시
// 시각(ms)(float64 일곱), BGRA 픽셀 순서다.
#include <stdbool.h>
// display 이면 창이 있는 디스플레이에서 이 앱의 창을 녹화한다. 창이 다른 Space(전체 화면)로
// 옮겨지면 창 녹화는 멈추지만 디스플레이 녹화는 그 Space 를 계속 녹화한다.
bool sp_capture_open(long windowNumber, bool display);
bool sp_capture_start(const char *directory);
const char *sp_capture_error(void);
int sp_capture_wait(void);
// 표시 시각 after(ms, mach 절대 시각)와 호출 시각 중 늦은 시각 이후의 화면이 스트림에 전달된 뒤
// 녹화를 멈추고 기록한 프레임 수를 반환한다. 상한에 도달해 자동으로 멈춘 경우에도 기록된 수를
// 그대로 반환한다. 상한 도달 여부는 sp_capture_limited 로 확인한다.
int sp_capture_stop(double after);
// 마지막 녹화가 유한한 프레임 상한에 도달해 멈췄으면 true를 반환한다.
bool sp_capture_limited(void);
// 마지막으로 멈춘 녹화에서 연속한 완성 프레임 사이의 가장 긴 표시 간격(ms). 이보다 긴 간격에는
// 기록되지 않은 화면이 있다.
double sp_capture_longest_gap(void);
// 윈도 서버 번호 windowNumber 의 창을 포커스를 주지 않고 한 장 찍어 path 에 PNG 로 쓴다.
// 개발 중 눈으로 확인하는 관측 자료를 만든다. 측정은 녹화 프레임으로 한다. 실패하면 false 를
// 반환하고 sp_capture_error 가 이유를 반환한다.
bool sp_capture_still(long windowNumber, const char *path);
