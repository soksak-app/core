# Release 설치

[English](install.md)

각 release는 macOS arm64 애플리케이션 세 개, `soksak-<version>-darwin-arm64-wailsv3.zip`, `soksak-<version>-darwin-arm64-tauriv2.zip`, `soksak-<version>-darwin-arm64-mygo.zip`, 즉 [registry](../spec/installation.ko.md#애플리케이션-업데이트)의 core release가 쓰는 이름을 게시한다. 각각 `soksak.app`을 담고, 데이터는 서로 다른 설정 폴더 `app.soksak.wails`, `app.soksak.tauri`, `app.soksak.mygo`에 둔다([projects](../spec/projects.ko.md#저장)). 둘 이상 설치하려면 나머지의 이름을 바꾼다. 예를 들면 `soksak (Tauri).app`이다.

애플리케이션은 Developer ID로 서명하거나 공증하지 않았으므로, macOS는 받은 사본의 첫 시작을 거부한다. 설치하는 방법은 다음과 같다.

1. zip 파일을 열고 `soksak.app`을 `Applications`로 옮긴다.
2. 한 번 시작한다. macOS가 애플리케이션을 확인할 수 없다고 알린다.
3. 시스템 설정의 개인정보 보호 및 보안에서 `soksak.app`의 그래도 열기를 고른 뒤, 다시 시작하고 열기를 확인한다.

또는 첫 시작 전에 Terminal에서 받은 파일의 격리 표시를 지운다: `xattr -dr com.apple.quarantine /Applications/soksak.app`.

메모리 절약은 기본으로 켜져 있다. `surface.unload`를 선언한 plugin의 숨긴 탭을 unload하고, 다시 보이면 restore한다([메모리 절약](../spec/plugins.ko.md#메모리-절약)).

첫 시작에서 애플리케이션은 공개 registry `https://soksak-app.github.io/registry/index.json`에서 시작 plugin을 설치한다([첫 실행](../spec/installation.ko.md#첫-실행)).

macOS 애플리케이션은 시작할 때 사용자 PATH 등록을 준비한다. 새 login shell에서 `sok`을 찾을 수 있다. 설정의 에이전트 그룹에서 등록을 제어한다. [사용자 PATH 등록](../spec/cli.ko.md#사용자-path-등록)

## 로컬 개발 연결

로컬 개발에서는 각 dependency 위치가 설치되어 있다고 가정하고, 각 위치를 개발 디렉터리에 심볼릭 링크로 연결한다. 이를 위해 저장소를 clone하거나 복사하지 않는다. 이 링크를 따르는 빌드는 revision을 checkout하거나, sparse-checkout 설정을 바꾸거나, release pin과 다르다는 이유로 편집 가능한 소스를 거부하지 않는다. 소스 identity는 release 검증과 분리해 기록한다. 연결된 소스와 실제 설치는 같은 선언된 설치 경로로 소비하며 Git metadata를 요구하지 않는다. dependency 설치와 release pin 검증은 별도의 설치 단계가 담당한다. 경로는 가정한 상대 위치가 아니라 선언이나 발견(매니페스트, 모듈 해석, 빌드 변수)으로 해석한다.
