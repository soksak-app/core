// Package darwin 은 네이티브 호스트의 macOS 구현이다.
//
// 창 단추, 좌표 변환, 입력 등록, 표면 배치, 녹화와 Dock 메뉴는 native/darwin 라이브러리가
// 구현한다. 라이브러리의 헤더와 링크 옵션은 pkg-config 의 soksak-darwin 에서 찾는다.
// 이 패키지는 그 함수와 webview.m 의 웹뷰 생성 코드를 platform.Platform 으로 등록한다.
package darwin
