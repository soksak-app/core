// stage.mjs 가 배포 루트에 만들어 넣는 파일 이름.
// 이 목록은 선언과 실제를 맞추기 위해 stage.mjs 가 import 해서 검증한다.
//
// 배포 루트 파일(모듈이 직접 import 가능):
// - always: 모든 빌드에서 생성
// - diagnostics: --diagnostics 플래그 있을 때만 생성
//
// 주의: modules/ 아래로 복사되는 패키지 파일들은 여기 선언하지 않는다.
//      각 패키지의 files 배열로 관리하고, stage.mjs 가 그것을 복사할 뿐이다.
export const STAGED = Object.freeze({
  always: Object.freeze([
    "diagnostics.js", // --diagnostics면 observe.js 복사본, 아니면 release-diagnostics.js 복사본
    "environment.json", // 애플리케이션 설정
    "diagnostic-plugins.json", // --diagnostics면 플러그인 진단 선언, 아니면 {}
  ]),
  diagnostics: Object.freeze([
    "transcript.js", // 진단 모듈이 사용하는 호출 기록기
  ]),
});
