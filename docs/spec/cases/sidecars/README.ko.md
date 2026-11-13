# Sidecar fixture

`fixture.sh`는 control 파일의 지시대로 sidecar wire를 수행하는 POSIX sh 프로그램이며, Go와 Rust host 테스트가 sidecar 실행 파일로 사용한다. 각 테스트는 선언된 sidecar마다 폴더를 만들고, 그 안에 sidecar의 실행 파일 이름으로 프로그램을 link하며, 같은 폴더에 `control` 파일을 쓴다. 프로그램은 link 옆의 `control`을 읽어 파일의 연산을 순서대로 수행한 뒤 표준 입력에서 읽은 줄에 응답한다. 연산과 오류 형식은 `fixture.sh` 맨 위에 나열되어 있다. control 파일의 줄은 테스트가 판정하는 host 코드의 입력 데이터이므로, host는 프로그램이 쓰는 모든 줄을 처리해야 하며, 이 프로그램은 sidecar 구현이 아니다.
