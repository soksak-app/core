# 프로젝트·설정·창

[English](projects.md)

독립 창 선언, 배치, 연결, 레일 경계선 계약은 [외부 창 사이드바](external-sidebars.ko.md)에 정의한다. 카드 내부 변 계약은 독립적으로 유지한다.

이 명세는 애플리케이션의 프로젝트 등록 목록, 영구 설정, 프로젝트 창을 정의한다. [기능](../features.ko.md)은 구현과 검증을 구분해 기록한다.

## 프로젝트 식별

프로젝트 하나는 존재하는 디렉터리 하나를 나타낸다. 네이티브 호스트는 현재 사용자의 `~`를 확장하고, 절대 경로와 심볼릭 링크를 해석하며, 디렉터리인지 확인한 뒤 파일시스템 식별자를 보고한다. macOS에서는 `<volume UUID>:<inode>`이며, 여기서 UUID는 volume이 저장하는 UUID(`getattrlist`의 `ATTR_VOL_UUID`)이고 inode는 inode 번호다. 두 값은 부팅과 remount를 거쳐도 같게 유지된다. volume의 device number는 부팅할 때마다 다시 매겨지기 때문이다. Windows에서는 volume serial number와 file index다. `projects.json`의 reader는 플랫폼 형식과 다른 identity를 가진 record를 거부한다(macOS에서는 `<volume UUID>:<inode>`: 대문자 8-4-4-4-12 16진수 형식의 36자 UUID, 콜론, 10진수 inode). 거부 오류는 `projects.json: project <root> has the identity <identity>, not <volume UUID>:<inode>`이며, 이전 형식 `<device>:<inode>`의 저장된 identity는 변환하지 않는다. 프로젝트 등록 목록은 같은 identity와 같은 정규 경로의 중복을 거부한다. 같은 디렉터리를 다시 열면 기존 프로젝트와 창을 선택하며 프로젝트를 새로 만들지 않는다. 프로젝트 이름은 바꿀 수 있으며 identity를 결정하지 않는다.

## 프로젝트 홈

앱 시작과 새 창 동작은 선택한 프로젝트가 없는 일반 앱 창에 프로젝트 홈을 표시한다. 첫 프로젝트를 만들거나 열면 같은 OS 창에서 홈이 그 프로젝트의 작업 화면으로 바뀐다. 프로젝트 홈은 화면이며, 별도의 창 유형이나 placeholder 프로젝트가 아니다. 기존 작업 화면을 다시 불러오면 그 창의 선택한 프로젝트를 유지한다. 디렉터리가 없으면 보이는 오류를 표시하고 저장된 프로젝트 데이터는 지우지 않으며, 프로젝트 선택은 계속 쓸 수 있다.

프로젝트 홈은 탭이 없고 플러그인 항목이 없는 런처 화면 하나다. 플러그인은 [설정 탭](settings.ko.md#플러그인)에서 관리한다. 홈은 위에서 아래로 다음 요소를 보여 주며, 동작하는 요소는 각각 자기 선언된 명령을 이름으로 적는다.

1. SOKSAK 로고와 줄 어디서 시작할까?. 이 글은 명령이 없다.
2. 자리 표시(placeholder) 문구 프로젝트 찾기 또는 폴더 경로 붙여넣기를 가진 검색 칸(element `core.home.search`). 홈이 보이면 칸이 포커스를 받는다. 입력하면 `core.home.search {query}`를 실행하며, 목록은 각 프로젝트를 이름과 경로로 맞춘다. `core.home.search.focus`는 칸에 포커스를 두며 `cmd+o`에 묶여 있다([exposure](exposure.ko.md)). Escape는 검색어가 비어 있지 않으면 `core.home.search {query: ""}`를 실행한다. 묶인 `core.home.search.focus`의 단축키 ⌘O를 칸 뒤의 글로 보이며, 묶인 단축키가 없는 동안에는 글을 보이지 않는다.
3. 버튼 두 개가 있는 줄. 기본 버튼인 새 프로젝트(element `core.home.add`)는 `core.home.form.open {mode: "create"}`를 실행한다. 폴더 열기는 `core.home.form.open {mode: "open"}`을 실행하며, 이는 기존 폴더를 받아들이는 폼을 연다. Git clone 버튼은 보이지 않는다.
4. 프로젝트 목록. 고정한 프로젝트가 먼저 묶음 제목 고정 아래에 나온다. 나머지 프로젝트는 묶음 제목 최근 아래에 나오며, 최근 묶음 제목은 고정한 프로젝트가 있는 동안에만 보인다. 각 묶음 안의 순서는 마지막으로 연 시각의 최신순이다. 목록에는 정렬 컨트롤이 없다. 줄의 어느 곳을 누르든 `core.home.open {project}`를 실행하며, 프로젝트를 그 자리에서 연다. 각 줄은 한 줄에 다음을 보여 준다:
   - 이름의 첫 글자를 담은 문자 정사각형. 적용된 테마의 text 토큰과 함께 accent 토큰을 쓴다.
   - 이름. `core.home.open {project}`를 실행하는 버튼이다(element `core.home.open`). 열린 프로젝트는 배지 열림을 보여 준다.
   - 고정폭 글꼴의 전체 경로. 한 줄로 자르며, 툴팁은 전체 경로다.
   - 스페이스 수 스페이스 <n>과 마지막으로 연 날: 최근 일주일 안이면 오늘, 어제, <n>일 전, 그보다 오래되었으면 <M>월 <D>일.
   - 고정 버튼. 마우스를 올리거나 선택하면 보이며, 고정한 줄에는 항상 보인다. `core.home.pin {project}`를 실행한다(element `core.home.pin`). 툴팁은 위에 고정 또는 고정 풀기다.
   - × 버튼(element `core.home.remove-ask`). 마우스를 올리거나 선택하면 보인다. 프로젝트를 제거하지 않으며, `core.home.confirm {project, answer: "ask"}`를 실행해 줄을 확인 상태로 바꾼다. `cmd+Backspace`는 양식이 없을 때 선택한 줄에 같은 `ask`를 실행한다. 검색 칸에서도 실행되며 칸의 글은 그대로 둔다. `core.home.confirm`에 project가 없으면 선택한 줄을 고른다.

   확인 상태는 줄을 "<name> — 목록에서 뺄까? 폴더는 그대로 둔다." 글과 버튼 두 개로 바꾼다. 취소는 `core.home.confirm {project, answer: "no"}`를 실행하며 줄을 되돌린다. 위험 버튼인 빼기는 `core.home.confirm {project, answer: "yes"}`를 실행하고, 이 명령은 `core.home.remove {project}`를 실행한다. 제거는 기록과 그 스페이스를 지우며 폴더는 바꾸지 않는다.

   홈을 보이면 첫 줄이 선택된다. ↑와 ↓는 step −1 또는 1로 `core.home.select {step}`을 실행하며, 목록 끝에서 돌아간다. Enter는 `core.home.open`을 실행해 선택한 줄을 연다. 홈은 이 절에 적힌 키 밖의 다른 키를 묶지 않는다.
5. `/` 또는 `~`로 시작하고 맞는 프로젝트가 없는 검색어는 줄 이 경로를 프로젝트로 연다를 추가한다. 이 줄은 고정폭 글꼴의 경로와 기본 버튼 열기를 가진다. 버튼은 `core.home.form.open {mode: "open"}`을 실행하며, 경로를 폼의 상위 칸에 넣는다. 그 밖에 맞는 프로젝트가 없는 검색어는 "“<query>”와 맞는 프로젝트가 없다."를 보인다(element `core.home.no-results`).
6. 키 안내 줄: ↑↓ 이동, Enter 열기, ⌘⌫ 목록에서 빼기, ⌘, 설정. ⌘⌫ 키는 선택한 줄에 `core.home.confirm {answer: "ask"}`를 실행하고, ⌘, 키는 `core.settings.open`을 실행한다([설정](settings.ko.md)). 이 줄은 홈이 묶은 키만 적는다.

프로젝트 홈의 제목줄에는 설정 버튼 하나만 보인다([창 도구](external-sidebars.ko.md#창-도구)). 제목줄 로고는 `core.projects.browse`를 실행한다. 이 명령은 현재 작업을 유지하면서 그 창에 프로젝트 홈을 보여 준다. 작업 화면의 상태 막대에 있는 항목 홈은 `core.home.show`를 실행하며, 같은 방식으로 그 창에 프로젝트 홈을 보여 준다. 프로젝트를 선택하거나 작업으로 돌아오면 작업 화면을 복원한다. 새 창은 항상 프로젝트가 배정되지 않은 창을 만든다. macOS에서는 모든 창을 닫아도 이 동작을 쓸 수 있도록 앱을 유지한다. Command/Ctrl+Shift+N과 macOS Dock 메뉴는 같은 동작을 실행한다. 프로젝트 홈은 프로젝트 작업 화면에서 돌아온 경우에도 항상 공통 설정을 쓴다. 작업 화면으로 돌아가면 그 프로젝트의 덮어쓰기를 다시 적용한다.

프로젝트 홈이 선언하는 명령과 element는 다음과 같다: `core.home.show`, `core.home.search`, `core.home.search.focus`, `core.home.select`, `core.home.open`, `core.home.form.open`, `core.home.pin`, `core.home.confirm`, `core.home.remove`, `core.home.no-results`, `core.home.add`, `core.home.remove-ask`, `core.home.back`, `core.home.status.projects`, `core.home.status.open`, `core.home.status.plugins`, `core.home.status.back`, `core.home.status.new`. 상태 `core.home`은 `query`(검색 문구), `selected`(선택한 줄의 프로젝트 id 또는 `null`), `rows`(보이는 순서의 프로젝트 id), `previewErrors`, `folderErrors`, 상태줄용 `projects`(프로젝트 수), `open`(창이 연 프로젝트 수), `plugins`(`enabled`, `installed` 수)를 보고한다.

## 프로젝트 열기

프로젝트 열기에는 네이티브 ownership 단계와 페이지 데이터 단계가 있다. `projectOpen`은 ownership을 기록하고 `{local, staged}`를 반환한다. 이때 확정된 shown project는 바꾸지 않으며 project 메시지도 보내지 않는다. `staged`는 이번 호출이 아직 `projectShown`으로 확정되지 않은 ownership을 예약했을 때 `true`다. 이미 확정된 owner를 다시 여는 호출은 `false`다. Geometry는 새 owner를 예약하기 전에 적용한다. Geometry 적용이 실패하면 새로 연 별도 창은 닫고, 재사용한 창은 이전 geometry를 복원한다. 로컬 열기가 성공하면 메인 페이지가 선언된 project-data context를 준비하고 프로젝트의 settings scope를 선택한 뒤 context를 설치하고 `projectShown({id, root, title})`을 호출한다. 그러면 host가 shown project를 확정한다. 네이티브 열기가 실패하면 이전 data context와 확정된 shown project를 유지한다. Commit 전에 settings 선택이나 네이티브 검증이 실패하면 페이지는 이전 settings와 data context를 복원하고, 새로 staged된 owner만 해제한다. 각 plugin data 호출은 시작할 때 활성인 context를 캡처한다. Context 설치 전에 시작한 호출은 이전 프로젝트의 접근 함수를 유지하며, 이후 호출은 준비된 context를 쓴다. 다른 창이 소유한 요청은 소유 창이 `project-activate`를 처리하고 자기 data context를 준비한 뒤에만 게시한다. 시작할 때는 페이지가 이 순서를 마친 뒤 `windowReady`를 호출한다. 첫 DOM 레이아웃은 이 순서가 끝나기 전에 시작 문서 스냅샷으로 그릴 수 있다. 하지만 네이티브 뷰와 백그라운드 sidecar 세션은 페이지가 shown-project context를 확정하고 해당 레이아웃을 설치한 뒤에야 시작한다. 시작 gate는 동기 layout 로드 뒤에 열리며, 네이티브 presentation을 기다리기 전에 열린다. 그래서 프로젝트 전환은 surface 구성을 기다릴 수 있다. 초기 프로젝트를 활성화할 수 없으면 페이지는 gate를 열기 전에 preview를 프로젝트 홈으로 비운다. 초기화 자체가 실패하면 시작 대기자는 reject되며, 이후 background session 갱신은 멈춘다. 프로젝트가 없는 시작 문서에는 gate가 없다. 이 규칙들은 첫 시각 레이아웃을 유지하면서, 처음 만드는 네이티브 세션과 background 세션이 확정된 프로젝트 root를 받도록 보장한다.

프로젝트를 다른 창이 소유하면 `projectOpen`은 그 창에 `project-activate`를 보내고, 애플리케이션을 활성화하지 않은 채 그 창을 애플리케이션의 다른 창들 앞에 key window로 둔다. 애플리케이션 안에서 온 요청이면 애플리케이션은 이미 활성 상태다. Endpoint나 command line으로 온 요청은 사람이 쓰는 애플리케이션의 키보드를 빼앗지 않으며, 결과는 시스템이 활성화를 허용하는지와 무관하다.

프로젝트 활성화와 프로젝트 홈 비우기는 하나의 직렬화된 transition lane을 공유한다. 활성 프로젝트가 registry에서 제거되어 생기는 비우기도 포함한다. 이후 활성화는 그 비우기가 끝난 뒤에 레이아웃을 불러온다.

프로젝트에서 연 terminal이나 shell surface는, 디렉터리를 보고한 surface에서 분할한 경우가 아니면 프로젝트의 정규 root에서 시작한다([탭 알림](plugins.ko.md#탭-알림)).

## 공통 외관

프로젝트 홈과 프로젝트 작업 화면은 `app.css`의 글꼴, 색, 테두리, 모서리, 간격 정의를 함께 쓴다. `library.css`는 프로젝트 홈 배치와 컴포넌트 위치를 정의한다. 별도의 글자 크기 체계나 고정 테마 색과 모서리 반지름은 정의하지 않는다.

설정한 글꼴과 기본 크기는 두 화면에 적용한다. 기본 크기 13px에서 프로젝트 이름과 컨트롤은 12px, 보조 콘텐츠는 11px, 메타데이터와 상태 문구는 10px을 쓴다. 이 크기들은 기본 크기에 비례해 조정된다. 본문과 컨트롤은 같은 행간과 일반 자간을 쓰며, 섹션 제목은 자간 값 하나를 공유한다. 화면 제목은 별도의 큰 표시 스타일 대신 기본 크기를 쓴다.

프로젝트 홈의 컨트롤, 폼, 줄, 키 안내 줄은 작업 화면의 조밀한 간격과 테마에서 얻은 테두리와 모서리를 쓴다. 글꼴, 크기, 테마, 모서리 설정을 바꾸면 두 화면에 같은 정의가 적용된다.

## 설정

프로젝트 홈은 기본값과 공통 설정만 적용한다. 프로젝트 작업 화면은 여기에 그 프로젝트의 명시적 덮어쓰기를 추가로 적용한다. 선택된 설정 프로젝트가 유효 값, 기본 쓰기 대상, 제공하는 범위를 정한다. 프로젝트 홈은 이 선택을 해제하되 창의 프로젝트와 저장된 덮어쓰기는 유지한다. 작업 화면을 선택하면 설정 프로젝트를 복원한다.

모든 설정 페이지는 컨트롤 위에 전역과 프로젝트 이름의 범위 구분 탭을 둔다([페이지 머리](settings.ko.md#페이지-머리)). 설정 메뉴는 페이지와 플러그인을 나열하며 범위를 두지 않는다. 각 프로젝트 창은 설정 탭 하나를 가지며([열기와 닫기](settings.ko.md#열기와-닫기)), 그 범위는 창의 프로젝트다. 프로젝트 홈에는 프로젝트 범위가 없고 전역만 제공한다. 전역과 프로젝트 범위는 프로젝트 작업 화면에서 제공한다. 프로젝트 홈으로 돌아오면 프로젝트의 저장된 덮어쓰기는 바꾸지 않고 편집 범위를 전역으로 바꾼다. 다른 분류를 고르면 그 컨트롤에 적용할 범위를 유지한다. 프로젝트 값을 지우면 공통 값을 다시 상속한다. 공통 값을 바꾸면 그 값을 덮어쓰지 않은 열린 모든 프로젝트에 반영한다.

프로젝트 열기 방식은 공통 설정에만 있다. `tabs`는 현재 창에서 프로젝트를 연다. `windows`는 현재 창이 이미 프로젝트를 가지고 있을 때 다른 프로젝트를 별도의 최상위 OS 창에서 연다. 프로젝트가 없는 창은 첫 프로젝트를 항상 그 자리에서 연다. 프로젝트 폴더 설정은 이 방식을 덮어쓸 수 없다. 프로젝트 범위에서 이 키로 `core.settings.change`를 실행하면 -32602(invalid params)로 실패하며 아무것도 바꾸지 않는다. 이미 열린 프로젝트를 선택하면 기존 창을 재사용한다. 열기 방식을 바꾸면 이후 프로젝트 열기에 적용되며, 실행 중인 창과 셸을 닫지 않는다.

프로젝트 창은 독립된 OS 창이다. 설정 탭과 추가·분할 메뉴는 [네이티브 모달](native-modals.ko.md)이 정한 창 내부 네이티브 webview에 남는다. 각 프로젝트 창은 활성 프로젝트, surface, 모달, 테마, 입력 상태, 셸 구독을 소유한다. 한 창의 레이아웃 준비, 다시 불러오기, 설정, 닫기가 다른 창의 네이티브 상태를 바꾸면 안 된다.

레지스트리에서 프로젝트를 제거하면, 즉 프로젝트 탭의 ×나 프로젝트 홈의 제거 버튼(`core.home.remove`)으로 어느 창에서든 제거하면, 그 프로젝트를 보이는 창은 두 경우 모두 같은 방식으로 프로젝트를 끝낸다. 프로젝트를 자기 화면에 보이는 창은 제거 전에 수정된 탭마다 묻는다([plugins](plugins.ko.md#탭-알림)). 다른 창이 보이는 프로젝트를 제거하는 창은 host를 거쳐(`windows.askRemoveProject`) 그 창에 묻는다. 프로젝트를 보이는 창이 수정된 탭마다 묻고 답하며, 제거는 그 답을 기다린다. 탭을 지키면 프로젝트는 레지스트리에 남고 `closed: false`로 답한다. 제거는 그 창의 답이나 그 페이지의 끝으로 끝난다. 묻는 동안 닫히는 창과, 묻는 동안 WebContent 프로세스가 끝났거나 다음 페이지가 시작해 페이지가 끝난 창은 그 끝의 turn에서 제거를 허용한다고 답한 것으로 본다. 끝난 페이지는 탭을 지키지 않으며, 새 페이지는 그 요청을 받지 않았기 때문이다. 그 창은 레지스트리 변경 알림으로 제거를 읽는다. 프로젝트 탭들의 surface module을 정리한 뒤 그 sidecar 세션을 끝내고([영속 서비스](persistent-services.ko.md#종료와-복구)), 남은 첫 프로젝트를 연다. 다른 프로젝트를 보이지 않는 창은 같은 OS 창에 프로젝트 홈을 보이고, 프로젝트가 없는 창으로 열린 채 남는다. `host.windows`는 그 창의 `project`를 null로 보고하며, `core.projects`는 제거한 프로젝트를 더 이상 나열하지 않는다. 창의 마지막 프로젝트 탭을 닫아도 결과가 같다. 창의 닫기 요청은 그 요청 전에 창이 시작한 레지스트리 읽기가 끝난 뒤에 실행된다. 그래서 다른 창이 제거한 프로젝트의 탭에 답한 창은, 닫기가 수정된 탭을 묻기 전에 그 프로젝트를 끝내며, 그 탭들을 다시 묻지 않는다.

## 저장

애플리케이션은 정렬된 프로젝트 등록 목록, 공통 설정, 폴더별 덮어쓰기, 스페이스, 활성 스페이스, 카드와 탭 상태, 문서 영역의 session 이력(`tab-sessions/`), 포커스 카드(`focusedId`, 포커스된 카드가 없으면 `null`([group card의 focus](groups.ko.md#focus)). 레이아웃의 어떤 카드도 가리키지 않는 저장된 `focusedId`는 `null`과 같이 포커스된 카드 없이 열린다. workbench가 ring을 받을 카드를 고르지 않기 때문이다. 값 `null`은 member의 값을 넓힐 뿐이고 이전 파일은 모두 그대로 유효하므로, 형식 변경이 아니며 형식 번호도 올리지 않는다), 숨긴 사이드바를 포함한 사이드바와 카드 사이드바의 너비, 각 사이드바의 선택된 탭과 접힌 섹션, 프로젝트 창의 크기와 위치를 저장한다. 창의 프로젝트 소유 관계와 실행 중인 셸 프로세스는 런타임 상태다. 프로젝트 창을 닫아도 저장된 프로젝트와 화면 설정은 유지한다. Host는 레지스트리의 모든 쓰기에 대해 쓴 창을 포함한 모든 창으로 `workspace-changed`를 보내며, 창은 레지스트리를 다시 읽는다. 같은 프로젝트와 같은 열린 프로젝트 id를 읽으면 아무것도 그리지 않는다.

네이티브 호스트는 앱 설정 디렉터리의 `settings.json`에서 공통 설정을 읽고, 프로젝트 디렉터리 안의 `.soksak/settings.json`에서 프로젝트 덮어쓰기를 읽는다. 설정 파일이 없으면 덮어쓰기가 없는 상태다. 프로젝트 파일은 명시적으로 바꾼 값만 담으며, 키를 지우면 상속이 복원된다. 공통 전용 키인 `projectOpening`, `textSize`, `memorySaver`, `memorySaverDelay`는 `packages/workbench/workbench.json`의 settings에 있는 목록 하나로 정하며, 각 language host 라이브러리가 내장 사본에서 읽는다([설정](settings.ko.md#값)). 이 키들은 프로젝트 설정에서 허용하지 않는다. 이 중 하나가 있는 프로젝트 설정 파일은 `<path>: <key> is common-only`로 거부되며, 프로젝트 쓰기는 `<key> is common-only`로 실패한다. 공통 전용 키가 있거나, 다른 형식이거나, 파싱되지 않아 거부된 프로젝트 설정 파일은 그 프로젝트에서 보고된다. 스냅샷은 그 프로젝트에 오류와 함께 `settingsError`를 주고 `settings`는 주지 않으며, 다른 프로젝트는 설정을 유지한다. 창은 그런 프로젝트를 열지 않는다. 거부된 파일을 대신할 설정이 없기 때문이다. 그 프로젝트를 열면 창, plane, 저장 기록이 바뀌기 전에 그 오류로 실패한다. 그 프로젝트를 가리키는 시작 문서는 프로젝트 홈을 그리고 오류를 한 번 보고한다. 표시 중인 프로젝트의 설정 파일이 거부되면 다음 스냅샷이 오류를 보고하며, 적용된 설정은 유지된다. 설정 폴더의 `projects.json`이나 `settings.json`이 거부되어도 스냅샷은 실패하지 않는다. 거부된 `projects.json`은 프로젝트 없이 오류를 담은 `projectsError`를 주고, 거부된 `settings.json`은 공통 설정 없이 오류를 담은 `settingsError`를 준다. 페이지는 각 오류를 보이고 시작한다. 그 뒤 프로젝트를 추가, 변경, 이동, 제거하면 `projects.json`의 오류로 실패하고, 공통 설정 쓰기는 `settings.json`의 오류로 실패한다. 두 파일 모두 바뀌지 않는다. Frame text factor는 공통 전용이다. 호스트가 페이지 시작 전에 이 값으로 창의 제목줄을 정하기 때문이다([제목줄 높이](native-surfaces.ko.md#제목줄-높이)).

기본 앱 설정 디렉터리는 다음과 같다.

| Host | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Wails | `~/Library/Application Support/app.soksak.wails` | `%AppData%/app.soksak.wails` | `$XDG_CONFIG_HOME/app.soksak.wails`, 미설정 시 `~/.config/app.soksak.wails` |
| Tauri | `~/Library/Application Support/app.soksak.tauri` | `%AppData%/app.soksak.tauri` | `$XDG_CONFIG_HOME/app.soksak.tauri`, 미설정 시 `~/.config/app.soksak.tauri` |
| mygo | `~/Library/Application Support/app.soksak.mygo` | `%AppData%/app.soksak.mygo` | `$XDG_CONFIG_HOME/app.soksak.mygo`, 미설정 시 `~/.config/app.soksak.mygo` |

디렉터리 이름은 애플리케이션 식별자다. 디버그 대상이 만드는 `dev` 플래그(Go 태그와 Cargo 기능 `dev`) 빌드는 `.dev`를 붙인다(`app.soksak.wails.dev`, `app.soksak.tauri.dev`, `app.soksak.mygo.dev`). 그래서 개발 빌드는 release 애플리케이션의 데이터를 읽거나 쓰지 않는다. `dev` 없이 빌드하는 진단 release는 release 식별자를 유지한다. 각 언어의 command line package가 식별자를 가진다(`packages/sok/go`의 `src/identity.go`는 Go host마다 애플리케이션 이름으로, `packages/sok/rust`의 `src/identity.rs`). Go host는 framework adapter의 애플리케이션 이름에 해당하는 식별자를 쓰므로, build tag가 host의 폴더를 고르지 않는다. Build tag `mygo`는 `sok` command의 host만 정한다(`src/wailsv3.go`와 `src/mygo.go`).

`--config-dir PATH`는 다른 애플리케이션 설정 디렉터리를 고른다. 호스트는 빈 경로를 거부하고, 경로에 없는 디렉터리를 권한 0700(소유자 전용)으로 만들며, 이미 있는 디렉터리의 권한은 유지하고, 정규 경로를 쓴다. 프로젝트 덮어쓰기 경로는 각 프로젝트 안에 남는다. 전역 편집은 공통 설정 파일을 바꾸고, 프로젝트 편집은 선택한 프로젝트의 설정 파일을 바꾼다. **전역 값 사용**은 개별 덮어쓰기를 지운다. 프로젝트 탭은 드래그해서 순서를 바꿀 수 있다. 프로젝트 홈은 이 순서를 쓰지 않는다. 탭의 ×는 레지스트리에서 프로젝트를 제거하며 폴더와 설정 파일은 보존한다. OS 창의 닫기 버튼은 레지스트리의 프로젝트를 보존한다.

애플리케이션 설정 디렉터리의 `projects.json`에는 정렬된 레지스트리, 프로젝트 화면 상태, `plugins` 아래의 프로젝트별 플러그인 데이터([프로젝트 데이터](plugins.ko.md#프로젝트-데이터))를 저장한다. 파일은 `projects` member 옆의 member `format`에 자기 형식을 싣는다(형식 4가 현재 형식이다. 이 형식에서 각 탭은 [agent role](agent-roles.ko.md#tab-role-state)의 member `role`을 가지며, 스페이스 레이아웃은 group card를 상자로 하는 grid의 slicing tree와 각 레벨의 leader를 담는다([group card](groups.ko.md#저장)). 형식 1부터 3까지와 프로젝트의 bare 배열을 포함한 다른 형태의 파일은 거부된다, [저장 데이터 형식](installation.ko.md#저장-데이터-형식)). Wails와 Tauri는 각자의 애플리케이션 설정 디렉터리를 쓴다. 네이티브 호스트는 변경을 직렬화하고, 영향을 받는 파일을 갱신하기 전에 다시 읽으며, 같은 디렉터리에 임시 파일을 쓰고, 쓰기가 끝나면 대상 파일을 교체한다. 교체가 성공하면 열린 창에 변경을 알린다. 설정 파일은 다시 불러올 때와 프로젝트를 선택할 때 다시 읽는다. 저장 실패는 화면에 보이게 알리며, 기본값으로 초기화하거나 저장된 데이터를 조용히 덮어쓰지 않는다. 준비된 프로젝트 창을 닫을 때는 대기 중인 저장을 끝낸 뒤 네이티브 자원을 해제한다. 메인 페이지를 다시 불러올 때는 준비된 페이지에 대기 중인 저장을 끝내도록 요청(`core.projects.flush`)한 뒤 페이지를 교체한다. 앱을 종료하면 준비된 모든 창에 같은 저장을 요청한 뒤 종료한다.

호스트가 거부한 레이아웃이나 설정 쓰기는 그 쓰기를 호출한 call을 실패시킨다. 다음 쓰기는 그대로 호스트에 전달되며, 거부된 레이아웃의 다음 저장이 그것을 다시 쓴다.

앱 설정 디렉터리에는 [메모리 절약](plugins.ko.md#메모리-절약)의 탭 상태 저장소 `tab-state.json`도 있으며, member `format`의 형식은 1이다. 이 파일은 member `tabs`에 항목을 담는다. 항목은 탭 식별자와 레이아웃의 [section surface](plugins.ko.md#섹션) id마다 하나이며, 선택 필드 세 개를 가진다. `state: {format, value}`는 탭의 plugin이 `context.tab.state`로 쓴 상태다. `kept: true`는 `core.tab.keep`으로 사람이 표시한 것이다. `label`은 표면이 마지막으로 보고한 제목이다. `label`은 plugin이 `surface.unload`를 `{format, maxBytes}`로 선언한 탭에만 쓰며, 설정과 무관하다. `null` 제목 보고는 `label`을 지운다. 항목은 필드 하나라도 있는 동안만 저장하며, 항목이 없는 탭은 `null`을 읽는다. Label은 마운트되지 않은 탭을 위한 표시용 캐시다. 제목의 주인은 여전히 surface이고, 레이아웃의 `title`은 여전히 탭의 이름이다. 복원 뒤 첫 제목 보고가 캐시를 바꾼다. 하단 글과 디렉터리는 저장하지 않으며, 탭이 unload되었는지도 저장하지 않는다. 한 탭의 쓰기는 초당 최대 한 번으로 묶고 종료할 때 flush한다. 그래서 crash가 나면 마지막 1초 이내의 상태만 잃는다. 쓰기마다 이벤트 `workbench.tab.state.stored`가 발생한다. 항목은 그 탭을 제거하는 레이아웃 쓰기가 확인된 뒤에만 지운다. 불러올 때 저장소를 `projects.json`의 탭 식별자와 맞추며, 지우는 고아 항목마다 이벤트가 발생한다. 섹션 surface `<space>/<sidebar>/<section>`의 항목은 그 space가 `projects.json`의 space이고 그 사이드바가 창 사이드바(`left`, `right`)이거나 그 space 레이아웃의 카드가 가진 카드 사이드바 `<card>:<side>`인 동안 남는다. 불러오기는 사이드바 세트를 해석하지 않기 때문이다. Reader는 형식 1만 받으며, 다른 형식은 파일과 찾은 형식을 밝히는 오류로 거부한다. 탭 상태는 `projects.json`에 저장하지 않으며 그 형식은 바뀌지 않는다. 별도의 저장소가 잦은 상태 쓰기를 레이아웃 파일 전체에서 분리한다. plugin `data`는 탭이 아니라 프로젝트와 선언된 key마다 묶이기 때문이다.

앱 설정 디렉터리에는 [메모리 절약](plugins.ko.md#메모리-절약)의 탭 session 폴더 `tab-sessions/`도 있다. 탭 식별자 또는 [section surface](plugins.ko.md#섹션) id마다 파일 `<name>.json` 하나를 둔다. [dialog surface](plugins.ko.md#dialogs)의 문서 영역은 session을 두지 않는다. Dialog는 닫히면 끝나고 어떤 레이아웃도 다시 열지 않으므로, workbench는 dialog id의 session을 읽거나 쓰지 않는다. `<name>`은 식별자를 RFC 3986으로 percent-encoding한 값이며, unreserved 문자는 그대로 둔다. 따라서 탭 식별자의 이름은 식별자 자체다. 예를 들어 section surface id `spc-2wcnnb/left/files.tree`의 파일은 `spc-2wcnnb%2Fleft%2Ffiles.tree.json`이다. Host는 탭 식별자도 section surface id도 아닌 식별자를 거부한다. Session 목록은 둘 중 어느 것도 가리키지 않는 폴더의 파일 `<name>.json`을 그 파일을 밝히는 오류로 거부한다. 파일 내용은 `{format: 1, regions: {<region name>: {session}}}`이다. `session`은 그 이름의 문서 영역의 직렬화된 session 이력(`interactionState`)을 base64로 적은 것이며, 디코드한 크기로 최대 1 MiB다. 탭마다 파일이 따로 있으므로, 쓰기는 다른 파일과 같은 원자적 교체로 그 파일만 바꾼다. 매번 문서 전체를 다시 쓰는 `tab-state.json`은 다시 쓰지 않는다. 파일은 `tab-state.json`에서 그 탭의 항목을 지우는 경로에서 지운다. 탭을 제거하는 레이아웃 쓰기가 확인된 뒤에 지우며, 불러올 때의 맞춤도 지운다. 맞춤은 `projects.json`의 어떤 레이아웃에도 없는 탭의 파일을 이벤트 `workbench.tab.session.orphan`과 함께 지운다. 섹션 surface의 파일은 탭 상태 저장소의 규칙에 따라 남긴다. Reader는 형식 1만 받으며, 다른 형식은 파일과 찾은 형식을 밝히는 오류로 거부한다.

스페이스를 열면 표시 레이아웃을 교체하기 전에 내용 탭, 활성 탭, 고정 사이드바 ID, `{width}`와 `{height}` 레코드([외부 창 사이드바](external-sidebars.ko.md#고정-배치와-저장))를 검증한다. 저장된 레이아웃은 현재 형식으로만 읽는다. `edgeWidth`나 `railWidth`를 가진 레이아웃, 데이터에 `panels`나 `sidebar`를 가진 카드, 내용 카드 ID 아래에 저장된 사이드바 선택은 `projects.json`, 프로젝트 root, 스페이스, 발견한 내용을 밝히는 오류로 실패한다. 이런 항목은 변환하지 않는다. 불러오지 않은 plugin의 탭은 placeholder 카드로 연다([플러그인](plugins.ko.md#불러오지-않은-플러그인)). 내용 카드는 탭을 0개 이상 가진다. 탭이 없는 카드는 빈 카드이며 `activeId`로 `null`을 저장한다. 탭이 있는 카드는 그중 한 탭의 id를 저장하며, 다른 `activeId`는 `invalid stored active tab <card>`로 실패한다. 저장된 소유자 필드, plugin별 사이드바 ID, 오래된 레일 카드는 이유와 함께 명시적으로 실패한다. 프로젝트 홈은 그 이유를 해당 프로젝트의 줄에 보여 준다. 저장된 사이드바 설정은 등록되지 않은 섹션이나 잘못된 연결이면 실패한다([저장되는 세트와 연결](settings.ko.md#저장되는-세트와-연결)). 프로젝트 홈은 각 프로젝트의 활성 스페이스에 같은 검증을 적용한다. 저장된 레이아웃이 실패한 프로젝트는 줄의 경로 대신 그 오류를 보이며, `core.home`의 `previewErrors`로 보고한다. 명시적인 null 폭 또는 섹션 선택 레코드는 잘못된 값이다. 선택 필드가 없을 때만 선언된 빈 레코드 기본값을 쓴다. 거부된 뷰 origin은 스페이스가 아니라 탭 단위로 거부한다. 그 탭은 레이아웃에 남고 거부됨으로 표시된다. 스페이스를 여는 것과 저장하는 것은 여전히 성공한다([탭 origin](#탭-origin)).

스페이스의 레이아웃은 `sidebars`를 저장한다. 사이드바 ID(`left`, `right`, 또는 카드 내부 사이드바의 `cardId:side`)마다 `{tab, folded, sizes}`를 저장한다. `tab`은 `tabs` 세트에서 고른 섹션 id 또는 `null`이고, `folded`는 `list` 세트에서 접은 섹션 id들이다. `sizes`는 섹션 id에서 사람이 끌어 정한 높이로 가는 객체다. 높이는 32에서 4096 사이의 정수다. 사이드바의 어떤 섹션도 크기를 정하지 않았으면 레이아웃은 `sizes`를 생략한다([섹션](plugins.ko.md#섹션)). 다른 형식의 `sizes` 값은 `sidebar <sidebar> stores an invalid size of <section>: <value>`로 거부된다. 선택은 스페이스마다 저장한다. 오버라이드는 같은 고정 사이드바의 내용을 바꾸며 그 식별자는 바꾸지 않는다. 선택을 바꾸면 다른 레이아웃 변경과 같이 저장된 스페이스가 바뀐다. `sidebars`가 없는 레이아웃에는 저장된 선택이 없다. 남아 있는 섹션 선택은 그 섹션이 선택 세트에 있을 때만 적용된다.

스페이스의 레이아웃은 `lastCard`(스페이스가 발급한 가장 큰 카드 번호), root 레벨의 `leader`, 그리고 grid 옆의 group 트리인 `groups`를 저장한다. 각 group card는 노드 `{card, name, leader, members}`다. 형식과 거부 규칙은 [group 저장](groups.ko.md#저장)을 따른다.

`docs/spec/cases/layout`의 레이아웃 case가 이 형식을 값으로 기술한다. `stored.json`은 저장된 스페이스 레이아웃과 고정 사이드바의 `{width}`와 `{height}` 레코드의 검사를, `window-sidebars.json`은 고정 창 사이드바를 순서대로 배치한 결과를, `spaces.json`은 프로젝트 레코드의 스페이스, 활성 스페이스, 스페이스 counter를, `grid.json`과 `outline.json`은 레이아웃이 저장하는 `packages/soksak`의 grid와 outline을 기술한다. `packages/soksak`과 `packages/workbench`의 test, 그리고 `packages/workbench-mygo`의 Go layout 모델([워크벤치](hosts.ko.md#workbench))이 같은 파일을 실행한다. 그래서 case 하나는 모든 구현이 지키는 저장 형식에 대한 진술 하나다.

### 탭 origin

저장된 레이아웃의 각 내용 카드 탭은 선택 member `origin`을 가질 수 있다. 카드 `tabs`의 항목 안에 `{id, plugin, origin: {directory}}`로 둔다. `directory`는 절대 경로 또는 null이다. 탭을 열 때 원본 탭이 보고한 디렉터리다. 그 탭이 아무것도 보고하지 않았거나 원본 탭이 없으면 null이다. 원본 탭이 없는 경우는 새 스페이스의 첫 탭, 그리고 카드의 마지막 탭을 닫은 뒤에 연 탭이다. 이 member는 탭을 만드는 레이아웃 쓰기와 함께 기록하므로, 탭과 origin이 함께 저장된다. 형식은 1로 남는다. 이 member는 선택 항목이다. 공개된 core에는 뷰 탭이 없으므로 공개된 파일 가운데 이 형태가 바뀐 파일은 없으며, AGENTS.md의 형식 규칙은 적용되지 않는다.
Origin은 탭이 자기 스페이스의 저장된 레이아웃을 떠날 때만 끝난다. 즉 스페이스의 이전 저장 레이아웃에는 그 탭이 있었고 다음 저장 레이아웃에는 없을 때, 또는 스페이스를 닫을 때다. 다른 스페이스를 표시해도 origin은 바뀌지 않는다. 따라서 표시되지 않은 스페이스의 탭은 그 스페이스가 탭이 없는 레이아웃을 저장할 때까지 origin을 유지한다. 저장된 레이아웃을 떠난 탭의 surface가 아직 마운트되어 있으면, 그 탭은 surface가 폐기될 때까지 origin을 유지한다. Origin이 없다는 거부 문구는 그 origin을 떨어뜨린 레이아웃을 저장한 동작을 여전히 밝힌다. Surface가 폐기되기 전에 저장된 레이아웃이 다시 담은 탭은 origin을 유지하며 떠난 것으로 보지 않는다.

레이아웃을 읽을 때 각 탭의 origin을 탭을 만들기 전에 한 번 복원한다. 창은 프로젝트를 로컬에서 소유하기 전에 모든 저장 스페이스의 origin을 복원한다. 여기에는 레이아웃을 그리지 않고 retained view를 시작할 수 있는 비활성 스페이스도 포함된다. 뷰 탭(plugin이 뷰 surface를 선언한 탭, [뷰 표면](native-surfaces.ko.md#view-표면))은 유효한 member가 없으면 탭 단위로 거부한다. Member가 없거나, null이거나, `{directory}`가 아니거나, `directory`가 [뷰 표면](native-surfaces.ko.md#view-표면)의 경로 검사를 통과하지 못하는 경우다. 거부 문구는 탭 이름을 밝히며, 로그에 쓰고 탭에 표시한다. 탭은 레이아웃에 남고, 뷰는 시작하지 않으며, 스페이스를 여는 것과 저장하는 것은 여전히 성공한다. 거부는 예외로 던지지 않는다. Member가 없는 뷰가 아닌 탭은 released origin `{directory: null}`을 읽는다. 이 읽기는 워크벤치의 한 함수(`releasedNonViewOrigin`)가 담는다. 형식 1에서 뷰가 아닌 탭에 대한 released 규칙이며, 다른 탭의 대체 경로가 아니다. 기록된 origin도 적재된 origin도 없는 탭은 origin이 없으며, 그 값을 읽으면 예외를 던진다. 오류는 탭, 그 plugin, 창이 보여 주는 스페이스와 프로젝트, 탭을 만든 경로, 이 session이 그 탭을 가졌는지 여부, 그리고 저장된 레이아웃이 origin을 마지막으로 떨어뜨린 동작을 밝힌다. 이 동작은 스페이스와 프로젝트를 붙인 저장의 writing path(렌더 뒤 저장은 `drawn layout`), 스페이스와 프로젝트를 붙인 `recreate`, 스페이스와 프로젝트를 붙인 `close space`, 또는 저장된 레이아웃이 떨어뜨리지 않았으면 `no stored layout`이다. Origin은 `tab-state.json`이나 `tab-sessions/`에 저장하지 않는다. 그 파일들은 평범한 탭에서 지워지므로 origin을 담을 수 없다. 이 변경 전에 저장된 레이아웃의 탭에는 origin member가 없다. 그런 레이아웃의 뷰 탭은 열 때 거부되며 변환되지 않는다. 이 빌드가 저장한 레이아웃은 이전 빌드에서 지원되지 않으며, 이전 빌드는 다음 저장에서 그 member를 버린다.

레이아웃 쓰기는 자신의 쓰기 경로를 밝힌다: `add space`(표시된 프로젝트의 새 스페이스), `saved layout`(스페이스, 프로젝트 또는 창이 바뀌기 전에 표시된 레이아웃을 저장), `recreate`(창이 시작할 때 복원하는 레이아웃), `library replacement`(프로젝트 홈 또는 다른 프로젝트를 보이는 창에서 프로젝트를 활성화). 쓰기는 origin member 없이 저장하는 뷰 탭마다 탭, plugin, 쓰기 경로를 밝히는 오류 기록 하나를 남기며, 그 기록은 쓰기 시점에 애플리케이션 로그에 쓰인다. 레이아웃 읽기는 경로를 밝히지 않으며 아무것도 기록하지 않는다.

브라우저 예제는 브라우저 창과 IndexedDB 저장소를 쓰며, 네이티브 폴더에 설정을 쓰지 않는다. 입력한 경로만으로는 네이티브 파일시스템 식별자를 확인할 수 없으므로, 디렉터리 식별과 네이티브 창 배치에는 네이티브 호스트가 필요하다.

## 인수 기준

- 같은 폴더의 경로 표기와 심볼릭 링크는 프로젝트 하나를 선택한다. 여러 창에서 동시에 열어도 같다.
- 프로젝트 생성, 이름 변경, 제거, 순서, 고정, 마지막 열기 시각이 앱 재시작 뒤에도 유지된다. 시작은 프로젝트를 실행하지 않고 프로젝트 홈을 표시한다.
- 프로젝트 홈은 공통 설정만 쓰고 편집한다. 덮어쓰기가 있는 프로젝트 작업 화면을 떠난 뒤에도 같다. 작업 화면으로 돌아가면 그 프로젝트의 덮어쓰기를 복원하고 두 편집 범위를 제공한다.
- 공통 설정과 명시적 폴더별 덮어쓰기는 다시 불러오기와 재시작 뒤에도 유지된다. 덮어쓰기를 재설정하면 상속이 복원된다. 열기 방식은 프로젝트 폴더 설정에 없다.
- 앱 시작과 새 창은 네이티브 콘텐츠 surface와 셸 없이 프로젝트 홈을 표시한다. 첫 프로젝트 생성과 열기는 두 열기 방식 모두에서 그 OS 창을 재사용한다. 프로젝트가 이미 있는 창에서 다른 프로젝트를 고르면 공통 열기 방식을 따른다. 이미 열린 프로젝트를 다시 열면 기존 창을 선택한다.
- 선택한 프로젝트의 레이아웃, 탭, 사이드바 너비, 테마 설정, 일반 창 기하가 복원된다. 창을 닫아도 저장된 데이터는 유지된다.
- 등록되지 않은 플러그인을 이름으로 가리키는 저장된 스페이스는 검증 오류와 함께 열리지 않으며, 프로젝트 홈의 그 줄도 같은 오류를 보인다. 저장된 기록은 바뀌지 않는다.
- 호스트가 폴더를 읽을 수 없는 프로젝트는 프로젝트 홈 줄의 폴더 경로 아래에 이유를 보이며, `core.home`은 호스트 메시지를 `folderErrors`에 보고한다. 두 호스트 모두 [`workspace.folder.messages`](host-contract.ko.md)의 메시지를 쓴다. 줄은 선언된 메시지(폴더 없음, 읽기 권한 없음, 파일)를 경로 없는 이유로 보이고, 다른 메시지는 그대로 보인다. 프로젝트 홈은 보일 때마다, 그리고 레지스트리가 바뀔 때마다 호스트에 다시 묻는다. 줄의 열기 버튼은 비활성화되며, 명령으로 그 프로젝트를 열면 호스트 메시지로 실패한다. 기록은 사용자가 줄의 제거 버튼과 빼기 확인(`core.home.confirm`, 그다음 `core.home.remove`)으로 지울 때까지 프로젝트 홈에 남는다. 제거는 프로젝트 탭 닫기처럼 기록과 스페이스를 지우며 폴더는 바꾸지 않는다. 제거된 프로젝트를 보이는 창은 [설정](#설정)의 프로젝트 창 규칙이 제거에 대해 정한 대로 그 프로젝트를 끝낸다.
- 두 창은 독립적으로 렌더링하고 입력을 받는다. 설정 효과, 네이티브 surface, 셸, 정리는 소유 창에만 제한된다.
- 두 네이티브 호스트에서 기존 surface 배치, 소수점 렌더링, 모달 검사가 계속 통과한다. 운영체제별 네이티브 동작은 따로 기록한다.
