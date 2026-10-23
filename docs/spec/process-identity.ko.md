# macOS process display identity

선언된 child process는 domain runtime을 초기화하기 전에 LaunchServices display name을 등록한다. Process 선언은 완전한 표시 identity URI를 제공한다. 표시 identity는 package name, dependency key, executable path, executable basename과 별개다. Process는 executable path와 bundle identity를 바꾸지 않는다.

Core는 macOS 구현을 `native/darwin/process-identity` 경로의 versioned private package `@soksak/native-process-identity-darwin` (version `0.0.20`)로 제공한다. Sidecar repository는 이를 Git subdirectory dependency (`path:/native/darwin/process-identity`)로 pin한다. `os` 선언은 `darwin`이다. 다른 운영체제는 설치하거나 compile하지 않고 caller도 Darwin build에서만 호출한다. Package `prepare` script가 static library, public C header, relocatable pkg-config metadata를 만든다. Sidecar build system은 이를 명시적 build dependency로 소비해 정적으로 link한다. 결과 executable은 이 package, static library, core checkout path에 runtime 의존성이 없다. pkg-config link flags에는 필요한 macOS system framework가 유지된다.

Sidecar의 host-supplied `display_name`은 선언된 `displayName` URI `soksak://sidecar/<id>`와 정확히 같아야 한다. Public function:

```c
int soksak_process_set_display_name(
    const char *display_name,
    char *error,
    size_t error_capacity);
```

`display_name`은 정확한 prefix `soksak://sidecar/`와 영문 소문자로 시작하고 영문 소문자, 숫자, 하이픈만 포함하는 하나의 lowercase identifier segment (`[a-z][a-z0-9-]*`)를 가진 NUL-terminated ASCII URI여야 한다. 함수는 LaunchServices registration 성공, 현재 process ASN 확인, display name 설정 성공, 요청 값과 정확히 일치하는 readback 뒤에만 `0`을 반환한다. 잘못된 argument/identity 또는 LaunchServices 오류에는 nonzero를 반환한다. 실패 시 `error`와 `error_capacity`가 허용하면 실패한 operation과 status를 명시한 NUL-terminated 진단을 쓴다. Caller는 nonzero를 startup failure로 처리하고 진단을 보고하며 generic process name으로 계속 실행하지 않는다.

Artifact의 pkg-config 파일은 설치된 자기 위치를 기준으로 include와 static library 경로를 해석한다. Package build는 절대 core checkout 경로의 파일을 읽거나 link하지 않는다. Packed-package consumer test는 tarball을 별도로 설치하고 설치된 package의 pkg-config 경로를 찾아 static consumer를 compile하고 실행하며 executable에 package 경로 runtime 의존성이 없음을 확인한다. Core 소유 native test는 invalid identity, 주입한 registration/set 오류, 불일치 readback과 정확한 display-name registration 성공을 public API에서 검증한다. Sidecar repository는 자기 경계에서 startup 동작을 검사한다.
