# Release 설치

[English](install.md)

각 release는 macOS arm64 애플리케이션 두 개, `soksak-<version>-macos-arm64-wails.zip`과 `soksak-<version>-macos-arm64-tauri.zip`을 게시한다. 둘 다 `soksak.app`을 담고, 데이터는 서로 다른 설정 폴더 `app.soksak.wails`와 `app.soksak.tauri`에 둔다([projects](../spec/projects.ko.md#저장)). 둘 다 설치하려면 하나의 이름을 바꾼다. 예를 들면 `soksak (Tauri).app`이다.

애플리케이션은 Developer ID로 서명하거나 공증하지 않았으므로, macOS는 받은 사본의 첫 시작을 거부한다. 설치하는 방법은 다음과 같다.

1. zip 파일을 열고 `soksak.app`을 `Applications`로 옮긴다.
2. 한 번 시작한다. macOS가 애플리케이션을 확인할 수 없다고 알린다.
3. 시스템 설정의 개인정보 보호 및 보안에서 `soksak.app`의 그래도 열기를 고른 뒤, 다시 시작하고 열기를 확인한다.

또는 첫 시작 전에 Terminal에서 받은 파일의 격리 표시를 지운다: `xattr -dr com.apple.quarantine /Applications/soksak.app`.

첫 시작에서 애플리케이션은 공개 registry `https://soksak-app.github.io/registry/index.json`에서 시작 plugin을 설치한다([첫 실행](../spec/installation.ko.md#첫-실행)).

shell에서 애플리케이션의 command line을 쓰려면 그 `sok path install`을 관리자 권한으로 실행한다: `sudo /Applications/soksak.app/Contents/MacOS/sok path install`([command line](../spec/cli.ko.md)).
