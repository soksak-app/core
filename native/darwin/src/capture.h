// 창 녹화. frame-NNNN.bgra는 uint32 너비·높이·행 간격과 float64 일곱 값
// (콘텐츠 x/y/너비/높이·콘텐츠 배율·장치 배율·ms 표시 시각)을 보존한다.
// 이어서 LZ4B 표식·uint32 압축 바이트 수·uint32 픽셀 CRC-32가 있는 80바이트 헤더와
// 단일 LZ4 RAW 블록이 온전한 BGRA 픽셀과 행 패딩을 복원한다. 이전 원시 형식은 거부한다.
#include <stdbool.h>
// display 이면 창이 있는 디스플레이에서 이 앱의 창을 녹화한다. 창이 다른 Space(전체 화면)로
// 옮겨지면 창 녹화는 멈추지만 디스플레이 녹화는 그 Space 를 계속 녹화한다.
// open/start의 error는 필수 출력 포인터다. 성공은 NULL, 실패는 호출자가 free()로 해제하는
// UTF-8 문자열이다. 활성 녹화 중 재요청은 녹화 상태·오류를 바꾸지 않고 거부한다.
bool sp_capture_open(long windowNumber, bool display, char **error);
bool sp_capture_start(const char *directory, char **error);
const char *sp_capture_error(void);
int sp_capture_wait(void);
// 표시 시각 after(ms, mach 절대 시각)와 호출 시각 중 늦은 시각 이후의 화면이 스트림에 전달된 뒤
// 녹화를 멈추고 기록한 프레임 수를 반환한다. 상한에 도달해 자동으로 멈춘 경우에도 기록된 수를
// 그대로 반환한다. 상한 도달 여부는 sp_capture_limited 로 확인한다.
// 쓰기 대기 용량이 소진되면 녹화가 실패한다. 종료는 이전 녹화 오류와 종료 오류를 모두
// sp_capture_error 에 보존하므로 반환한 프레임 수만으로 성공을 판단하지 않는다.
int sp_capture_stop(double after);
// 마지막 녹화가 유한한 프레임 상한에 도달해 멈췄으면 true를 반환한다.
bool sp_capture_limited(void);
// 마지막으로 멈춘 녹화에서 연속한 완성 프레임 사이의 가장 긴 표시 간격(ms). 이보다 긴 간격에는
// 기록되지 않은 화면이 있다.
double sp_capture_longest_gap(void);
// 현재 시각(ms). 기록 프레임의 표시 시각과 같은 시계다. 입력을 보낸 시각을 프레임과 비교할 때 쓴다.
double sp_capture_clock(void);
// 윈도 서버 번호 windowNumber 의 창을 포커스를 주지 않고 한 장 찍어 path 에 PNG 로 쓴다.
// 개발 중 눈으로 확인하는 관측 자료를 만든다. 측정은 녹화 프레임으로 한다. 실패하면 false 를
// 반환하고 error에 호출자 소유 오류 문자열을 기록한다. 성공 시 error는 NULL이며 호출자는
// 오류 문자열을 free()로 해제한다. 녹화 오류와 별개이며 error 출력 포인터는 필수다.
bool sp_capture_still(long windowNumber, const char *path, char **error);
