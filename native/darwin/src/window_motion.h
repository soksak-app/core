// 창 크기 변경 애니메이션의 길이.
//
// AppKit 은 `-[NSWindow animationResizeTime:]` 에서 사용자 기본값 NSWindowResizeTime 을 읽어
// 확대와 애니메이션 크기 변경의 길이를 정한다. 창 프레임과 웹 문서는 따로 표시되므로, 이 시간이
// 길수록 내용이 창보다 늦게 보이는 구간이 길어진다.
void windowResizeInstant(void);
