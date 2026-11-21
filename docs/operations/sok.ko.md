# `sok` 사용

[English](sok.md)

`sok`은 terminal에서 soksak 애플리케이션을 다룬다. 창을 나열하고, status를 읽고, core나 plugin이 선언한 모든 command를 실행하며, native 입력을 보낸다. 계약은 [command line `sok`](../spec/cli.ko.md)이다.

## Shell에서 `sok`에 닿기

각 애플리케이션 bundle의 `Contents/MacOS` 폴더에는 애플리케이션 실행 파일과 그 애플리케이션의 `sok` 실행 파일이 있다. 애플리케이션은 시작할 때마다 사용자 PATH 등록을 맞춘다. 이 등록은 관리자 권한 없이 사람의 shell `PATH`에서 그 `sok`을 찾을 수 있게 하며, 설정 창에서 켜고 끈다([사용자 PATH 등록](../spec/cli.ko.md#사용자-path-등록)). 그 뒤 새 shell이 `sok`을 찾으며, 그 `sok`은 그 애플리케이션과 통신하고 그 설정 폴더를 쓴다. `--config-dir`로 시작한 애플리케이션을 다루려면 `sok`에도 같은 `--config-dir`을 준다.

## 창 다루기

```sh
sok windows                                   # 실행 중인 애플리케이션의 창
sok commands --project ~/work                 # core와 plugin이 선언한 command
sok core.card.split --project ~/work --card shell --side right --plugin terminal
sok terminal.input --project ~/work --surface <tab> --bytes 'npm test\r'
sok status core.screen --watch                # 값, 그다음 변경마다 한 줄
```

`--window <name>`이나 `--project <directory>`가 창을 고른다. 둘 다 없으면 `sok`은 하나뿐인 창을 쓰고, 창이 여럿이면 선택을 요구한다. 선언된 command는 선언된 schema에서 나온 flag(`sok commands`가 보인다)나 `--params`의 JSON 객체 하나로 매개변수를 받는다. `--`로 시작하는 값은 `--text=--x`처럼 `=` 뒤에 쓴다.

모든 결과는 표준 출력의 JSON이므로, 한 호출의 결과가 다음 호출에 쓰일 수 있다. 예를 들어 `core.card.split`이 출력한 `tab`이다. 오류는 표준 오류로 간다. 종료 상태는 성공 0, command 실패 1, 잘못 쓴 호출 2이며, 2일 때는 사용법도 출력한다.
