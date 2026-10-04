// stage.mjs 가 배포 루트에 만들어 넣는 파일 이름.
// 이 목록은 선언과 실제를 맞추기 위해 stage.mjs 가 import 해서 검증한다.
//
// 배포 루트 파일(모듈이 직접 import 가능):
// - always: 모든 빌드에서 생성
// - diagnostics: --diagnostics 플래그 있을 때만 생성
// - served: host 가 제공하는 문서. 스테이징은 --installed 일 때만 쓴다
//
// 주의: modules/ 아래로 복사되는 패키지 파일들은 여기 선언하지 않는다.
//      각 패키지의 files 배열로 관리하고, stage.mjs 가 그것을 복사할 뿐이다.
export const STAGED = Object.freeze({
  always: Object.freeze([
    "diagnostics.js", // --diagnostics면 observe.js 복사본, 아니면 release-diagnostics.js 복사본
    "environment.json", // 애플리케이션 설정
    "runtime/start.js", // 애플리케이션 runtime 의 시작 문서 모듈
  ]),
  diagnostics: Object.freeze([
    "transcript.js", // 진단 모듈이 사용하는 호출 기록기
    "resize-loop.js", // 진단 모듈이 사용하는 ResizeObserver 루프 기록기
  ]),
  // 네이티브 host 가 요청마다 만들어 제공하는 문서. 호스트가 없는 애플리케이션은 --installed 스테이징이 쓴다.
  served: Object.freeze([
    "installed-plugins.json", // 켜진 설치 플러그인과 그 manifest(docs/spec/installation.md)
  ]),
});
