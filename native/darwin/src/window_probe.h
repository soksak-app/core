// 창 검사 요청을 실행한다. request 는 JSON 객체이고 op 는 dock, close, position, presentation,
// state, hit 중 하나다. 결과는 요청의 ticket 과 함께 JSON 으로 reply 에 전달한다. 주 스레드에서 호출한다.
void spNativeProbe(void *window, const char *request, void (*reply)(const char *));
