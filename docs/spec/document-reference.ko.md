# 렌더링된 문서 참조

이 진단 계약은 F696의 일부다. OCR 소비자나 플랫폼 검증 항목의 완료를 뜻하지 않는다. 렌더러 생산자 테스트, 호스트 컴파일, 네이티브 캡처 테스트, 실제 캡처, 소비자 전환은 각각 증거가 필요하다.

`diagnostics.capture.document-reference`는 `{window, surface, document, requestId}`를 받는다. `document`는 등록된 정확한 이름이며 root는 `""`다. `requestId`는 양의 JavaScript safe integer다. 기대 문구와 호출자 지정 generation을 포함해 선언되지 않은 필드는 거부한다. Attached document가 없다고 root를 대신 선택하지 않는다.

측정 구간 뒤에 시작한 `frameIdentity: true` 참조 recording이 활성 상태여야 한다. 호스트가 실제 현재 view generation과 정확한 native document를 해석하고 기존 capture identity 수명으로 source를 선택한 뒤 document producer를 설치한다. Root 전용 identity 권한은 별도 진입점으로 유지한다. 요청이 timeout되어도 capture-stop이 pending start, freeze, removal을 소유한다.

Native 경계는 숫자 carrier를 읽기 전에 검증한다. `schemaVersion`은 정확히 숫자 1이어야 하고, 반환된 `requestId`는 원래 요청의 양의 safe integer와 같아야 하며, `revision.value`도 양의 safe integer여야 한다. JSON null, object, array, string, boolean, 소수와 범위 밖 값은 오류다. Foundation bridge를 통해 boolean을 숫자로 받아들이지 않는다. 잘못된 metadata는 worker bridge를 통해 정확히 한 번 오류를 반환하고, native snapshot을 게시하기 전에 해당 provider lease를 해제한다. Native 관측은 기존 10.0초 deadline을 중앙 `sp_observe_timer` 입구(`document.reference.timeout`)로 유지하며 completion에서 timer를 무효화하고 해제한다.

문서 렌더러는 공개 page provider `soksakRenderedReference` version 1을 소유한다. 메서드는 `observe({requestId})`, `validate({requestId, revision})`, `release({requestId})`다. 정확한 요청 소유자가 해제할 때까지 한 요청만 producer를 빌린다. Observe는 소비자의 검증 기준을 받지 않는다. Dispose, 렌더러 교체, 문서 revision이나 geometry 변경은 관측을 무효화한다. Pending 관측이 해제되면 나중에 성공을 반환할 수 없다. Revision domain은 provider가 소유하는 비어 있지 않은 문자열이다. 호스트는 renderer 이름으로 분기하지 않고 이 domain과 양의 safe-integer counter를 그대로 같은 provider의 validate에 전달한다.

DOM producer는 렌더러 소유 root의 실제 텍스트와 grapheme 사각형을 브라우저 Range와 layout API로 읽는다. Revision은 `{kind:"dom-layout", value}`, source kind는 `native-document`다. Editor는 실제 CodeMirror `contentDOM`을 전달하며 자동화가 selector로 내부 구조를 찾지 않는다. 제어하는 Browser 문서가 canonical SDK provider를 직접 불러온다. DOM metadata 자체는 물리적 presentation이나 glyph pixel 증거가 아니다.

HWP는 Studio CanvasKit 렌더러를 사용한다. 실제 draw가 semantic glyph metadata와 변경 불가능한 PNG를 수집하고, 인코딩 전후의 document generation과 paint revision을 확인한 뒤 native CanvasKit 객체를 해제한다. Adapter는 `{kind:"canvaskit-paint", value:drawRevision}`, source kind `renderer-png`, 실제 인코딩된 PNG를 반환한다. 실제 보이는 렌더링 page가 정확히 하나여야 한다. 없거나 여러 개면 page zero를 추측하지 않고 실패한다. Studio 의존성 pin, 배포, 플랫폼 증거는 별도 검증 항목이다.

Observe 뒤에 native owner가 실제 document identity producer를 freeze하고 대상 WebKit update를 기다린 다음 정확한 native document의 표준 snapshot을 얻는다. Source tuple은 native snapshot의 완전한 QR을 실제 issued payload 집합으로 decode한 결과다. Snapshot 뒤에도 provider revision과 전역 native geometry가 같아야 한다. QR decode 실패를 포함해 실패 시 native PNG를 남긴다. Producer 데이터를 기대 문구나 만들어 낸 identity 필드로 대체하지 않는다.

Artifact는 반환된 workspace capture 하위의 비공개 directory에 속한다. `native.png`는 실제 native snapshot이고, 제공되는 `renderer.png`는 렌더러의 실제 PNG다. Manifest는 요청, producer metadata, source digest와 pixel 크기, 전역 geometry, decode한 identity와 QR ROI를 기록한다. 호출자는 실패 시 보존할 수 있도록 directory를 추적한다. 원래 recording 증거는 변경하지 않는다.

소비자는 정확한 target, source generation, region, decode한 tuple, digest, scale, geometry로 실제 recording과 참조를 연결해야 한다. 선택한 glyph와 guard pixel을 실제 capture pixel로 검증하고 QR과 겹치는 모든 선택 cell을 제외한다. Exact equality가 실패하면 원본 실패를 보존한다. QR identity, DOM 텍스트, renderer state, 마지막 ROI만으로는 충분하지 않다. OCR, tolerance, mask, state-only fallback은 없다.

Go와 Rust는 같은 transaction 경계를 노출한다. Native 구현이 없는 플랫폼은 명시적인 unsupported 오류를 반환한다. 이는 다중 플랫폼 완료가 아니다. Linux, Windows, CI recording, 실제 앱 검증을 각각 기록한 뒤 해당 항목을 닫는다.

## Producer 검증 기록 (2026-11-08)

증거는 `target/e2e/20261107T170825-Naslh4/reference-validation/`에 보존한다. 아래는 범위를 한정한 producer·인터페이스 결과다. 서로 겹치는 소유 검사 묶음이며 독립 기능의 완료 개수가 아니다.

Studio source의 upstream 기준은 `soksak-studio-v0.8.7-2`다. 최초 observe RPC는 Unknown method로 실패했다. CanvasKit 검사는 요청 snapshot 보존·revision fencing·인코딩 실패 처리가 없어서 실패했고 일반 draw의 무수집 검사는 통과했다. 같은 observe·snapshot 소유 검사 아홉 개가 통과했으며 visible-page 선택을 더한 묶음도 열세 개가 통과했다(`f696-studio-reference-nine-green.log`, `f696-studio-thirteen-green.log`). 실제 glyph geometry·draw 수명 검사는 geometry 부재나 restore 뒤 사라진 placement matrix 때문에 먼저 실패했고 같은 네 개가 통과했다(`f696-studio-glyph-geometry-red.log`, `f696-studio-glyph-draw-lifetime-red.log`, `f696-studio-glyph-geometry-draw-green.log`). 공개 embed 수명은 validate/release 경로와 발견 가능한 capability가 없어서 먼저 실패했으며 같은 여덟 개가 통과했다(`f696-studio-public-lifecycle-red.log`, `f696-studio-public-lifecycle-green.log`). 현재 source의 TypeScript·Vite 컴파일도 통과했다(`f696-studio-lifecycle-glyph-typecheck.log`, `f696-studio-glyph-lifecycle-build.log`). 이 결과가 새 Studio 의존성 pin의 배포나 게시를 뜻하지는 않는다.

DOM provider는 처음에 공개 factory가 없었고, 이어서 해제한 RAF와 완료되지 않는 font 대기의 취소 결함을 각각 드러냈다. 같은 기준의 수정으로 실제 DOM root·glyph range·정확한 lease 소유권을 유지한다. SDK 소유 검사 열한 개와 제어하는 Browser 문서의 배달 검사 한 개가 함께 통과했다(`f696-dom-provider-eleven-browser-green.log`: 열두 개). Editor는 실제 CodeMirror root 전달·provider 검사 두 개와 복사한 producer 계약 다섯 개가 통과했다(`f696-editor-reference-sdk-green.log`, `f696-editor-reference-contract-green.log`). Browser root 등록과 복사한 계약은 일곱 개가 통과했으며(`f696-browser-root-registration-green.log`) 제어하는 child `page`와 root 빈 상태 provider를 구분한다. Attached native identity 검사는 기존 root 전용 조건이 정확한 attached target을 거부해 먼저 실패했고, 그 root 전용 권한 경계를 유지하는 수정 뒤 통과했다(`f696-native-attached-identity-red.log`, `f696-native-attached-identity-green.log`). Native snapshot이나 실제 앱의 증거는 아니다.

HWP 공개 Studio adapter는 등록 부재로 먼저 실패했고, 다음으로 release 뒤 pending 관측이 끝나지 않는 결함을 보였다. 유지되는 빌드 명령으로 다시 만든 adapter는 같은 소유 검사 네 개가 통과했다(`f696-hwp-reference-provider-red.log`, `f696-hwp-pending-cancel-red.log`, `f696-hwp-pending-cancel-rebuilt-green.log`). 앞선 수정 후 실행인 `f696-hwp-pending-cancel-green.log`는 source를 다시 빌드하지 않아 오래된 `build/test/ui/hwp-diagnostics.js`를 읽었으며 세 개 통과·한 개 취소를 기록했다. 기존 `node scripts/build-test.mjs`로 그 입력을 다시 만든 뒤 기준을 바꾸지 않은 네 개가 통과했다. 두 로그 모두 보존하며 오래된 입력의 실행을 GREEN으로 세지 않는다.

Native 전체 소유 검사는 새 source로 컴파일됐다. 최초 fixture 실행은 문자열 generation에 `unsignedLongLongValue`를 보내 종료됐고, production 변경 없이 실제 wire schema를 더 엄격하게 확인하는 `isEqual:@"44"`로 교정했다. 다음 실행이 목표 RED였다. Pending target close가 closed 원인 대신 native deadline을 반환했고 `store-2` 종료도 20초 제한에서 실패했다(`f696-native-document-reference-string-owner.log`). 실패 PNG는 `/tmp/soksak-document-reference-evidence-95ebQy`에 보존했다. 원인은 metadata 반환 전에는 provider 요청을 소유하지 않는 것으로 처리해 pending WK 호출·관측·닫힌 view의 순환 보존을 남긴 것이었다. Deadline을 늘리지 않고 공개 observe 시작부터 소유권을 잡고 document close에서 공개 release로 취소하는 수정 뒤 같은 세 case가 3.226초에 통과했다(`f696-native-document-reference-close-green.log`). 실제 native PNG의 issued QR·canonical uint64 문자열, revision 거부 시 PNG 보존·정확한 lease 해제, pending close 원인·datastore 정리가 모두 유지됐다. 이 native 검사의 worker bridge spy는 실제 Go thread identity나 새 앱의 physical capture 증거를 대신하지 않는다.

Go 최초 시도는 오래된 native library의 누락 symbol 때문에 동작 검사 전에 막혔다. 유지되는 ABI 생성과 `build-mygo`로 현재 dynamic native artifact를 만든 뒤 원래 선언·잘못된 요청 검사와 요청 수명 검사 합계 다섯 개가 통과했다(`f696-document-reference-host-dynamic-current.log`). 검증 framework cohort는 **758**이며 checker 후보 6b9/85c4가 설치·게시됐다고 처리하지 않는다.

이어서 provider가 소유하는 다른 revision domain을 가진 네 번째 실제 native case가 core의 renderer 이름 제한 때문에 metadata 거부로 실패했다(`f696-native-reference-opaque-domain-red.log`). Core가 generic source 형식과 안전한 counter를 검증하고 opaque domain을 그대로 같은 provider의 validate에 전달하도록 고친 뒤 원래 세 case와 새 case가 모두 4.300초에 통과했다(`f696-native-reference-opaque-domain-green.log`). Rust 공개 endpoint 선언 소유 검사도 통과했다(`f696-document-reference-rust-declaration-green.log`). 이 결과는 유지되는 native·Go·Rust 경계 검사이며 새 앱 소비자의 pixel 검증을 대신하지 않는다.

F696과 OCR 소비자 parent는 열린 상태다. 새 앱 원본 PNG·reference recording, 엄격한 가장 이른 frame 소비자 전환과 plugin에 독립적인 proof-method 경계는 각각 검증해야 한다. 잘못된 provider metadata의 NSNull·coercion을 엄격히 거부하는 native JSON carrier 검증은 아래 23개 사례로 확인했다. Framework checker 후보는 설치되거나 게시된 framework가 아니다. Linux·Windows·CI·의존성 배달에도 명시적인 검증 항목이 남는다. 이 producer 결과만으로 OCR 교체·최종 G8·다중 플랫폼 완료·새 실제 앱의 pixel 증거를 주장하지 않는다.

잘못된 carrier owner의 최초 실행은 기존 네 사례를 통과한 뒤 `NSNull integerValue`의 uncaught `NSInvalidArgumentException`으로 4.869초에 중단됐다(`f696-native-malformed-carriers-red.log`). 이제 숫자를 읽기 전에 엄격한 NSNumber 검증으로 CFBoolean을 제외하고, 요청·revision 값의 safe integer 범위와 정확한 schema version 1을 검증한다. 같은 기존 네 사례와 잘못된 carrier 19개를 합친 23/23이 21.486초에 exit 0으로 통과했다(`f696-native-malformed-carriers-green.log`). 잘못된 provider 결과마다 worker bridge를 통해 명시적인 metadata 오류를 한 번 반환하고 해당 provider lease를 한 번 해제하며, 증거 디렉터리를 보존하고 native PNG는 게시하지 않는다. 중앙 관측 timer의 deadline은 기존 10.0초를 유지한다. 이는 native transaction과 carrier 검증이며 실제 앱 reference·pixel acceptance는 별도로 남는다.

## 소수점 native snapshot 검증 (2026-11-08)

첫 실제 비활성 Browser 관측은 기존 native deadline에 도달했다. 대조 실행에서는 다른 covered-reference 소유 검사에서 쓰는 공개 `diagnostics.window.draw-covered` 준비를 추가하고 cleanup에서 false로 복원했다. 같은 collector는 약 2초에 callback을 마쳤고 deadline·앱 오류 없이 비활성 audit을 통과했다. 이는 해당 준비를 적용한 reference 단계의 재현된 callback 차단을 해소한 결과이며, 최초 timeout의 어느 WebKit 렌더링 대기가 원인이었는지는 확정하지 않는다. 활성화·재시도·deadline 연장은 추가하지 않았다.

이 대조 실행은 올바른 콘텐츠가 보이는 원본 native PNG를 보존했지만 엄격한 geometry 검사에서 실패했다. 공개 preflight가 측정한 실제 document는 760 × 256.5pt, backing scale 2였으며 필요한 1520 × 513 대신 PNG는 1520 × 512였다(`f696-actual-browser-reference-mygo-preflight.log`). 소수점 native owner도 같은 실패를 재현했다. WebKit 원본 공개 image representation은 정확한 point 크기와 1520 × 513 픽셀을 보존했지만 context 없는 `CGImageForProposedRect`가 1520 × 512를 반환했다(`f696-native-fractional-geometry-red.log`). 손실은 PNG 쓰기 전 AppKit 이미지 선택·생성 경계에 있었으며 QR을 못 읽거나 geometry 기준이 틀린 문제가 아니었다.

이제 native owner는 실제 document의 논리·backing 크기와 정확히 맞는 원본 representation 하나만 허용한다. 공개 `NSImageRep`·`NSGraphicsContext`로 그 representation을 정확한 크기의 sRGB bitmap에 backing 픽셀과 일대일로 그린다. 없거나 모호한 representation, 잘못된 크기, 할당 overflow는 명시적으로 실패한다. Private representation class·selector, 잘린 이미지 확대, fallback, geometry 반올림·epsilon은 없다. 기존 PNG identity decode와 정확한 geometry 검사는 유지한다.

강화한 같은 사례의 RED는 geometry와 서로 다른 첫·마지막 physical row 검사에서 실패했다(`f696-native-fractional-row-valid-red.log`). 최초 fixture compile 오류는 타입이 명확한 bitmap initializer로, production compile 오류는 변환 전 정확한 크기 상한과 정수 할당 overflow 검사로 고쳤으며 setup 로그도 보존했다. 이후 `NSColor` 기반 row 검사 두 개의 실패는 oracle의 색 변환 때문이었다. 독립적으로 읽은 PNG 원본 sample은 이미 기대 RGB와 정확히 같았다. Owner는 이제 8-bit RGB·alpha sample 형식을 검증하고 `getPixel`로 encoded 정수 성분을 읽으며 같은 정확한 색 기준과 실제 값 진단을 유지한다. 같은 native 24개 사례가 22.457초에 exit 0으로 통과했다(`f696-native-fractional-encoded-row-green.log`). 1520 × 513, 첫·마지막 row의 정확한 RGBA, issued QR·identity, 잘못된 carrier 19개와 수명·close 검사를 포함한다. 앞선 색 oracle 실패 로그 `f696-native-fractional-row-compiled-green.log`도 보존하며 GREEN으로 세지 않는다.

다음 검증은 실제 host를 다시 빌드하고 같은 Browser collector를 실행해 원본 native PNG와 실제 ScreenCaptureKit recording을 연결하는 것이다. 이 native GREEN만으로 Browser·Editor·HWP OCR 소비자, 가장 이른 frame 증명, 의존성 배달, 플랫폼 검증이나 F696 parent를 닫지 않는다.

## Revision wire identity와 controlled collector 기록

Renderer revision은 정확히 `{kind, value}` 두 필드로 구성된 JSON object다. Native dictionary bridge가 `{value, kind}` 순서로 반환할 수 있으므로 validation은 property 순서와 무관하게 own field 이름과 값을 엄격히 비교한다. 추가·누락 필드, 다른 kind·value, 타입이 다른 value, null·array는 lease를 소비하지 않고 거부한다. Provider가 직접 생성한 layout observation은 별도로 비교하며 geometry·mutation·수명 검사를 완화하지 않는다.

결정적 owner의 RED는 같은 revision의 필드 순서만 바꿨을 때 `false !== true`로 실패했고 기존 11개 owner는 통과했다(`f696-revision-key-order-red.log`). 엄격한 의미 비교를 적용한 뒤 같은 12개가 통과했다(`f696-revision-key-order-green.log`). 이어 변경하지 않은 CGO0 mygo binary 052에서 controlled page에 수정한 원본 factory module을 제공해 같은 Browser collector가 2.489초에 통과했고 run audit도 통과했다(`f696-actual-browser-reference-mygo-revision-order.log`). 보존한 run `20261107T222710-11472`에는 원본 native PNG·recording frame 91개·matched tuple 3개가 있다. 이전 실패의 validation payload는 보존하지 않았으므로 key order가 유일한 원인이었다고 단정하지 않는다. 이 결과는 제한된 mygo collector와 packet association을 검증하며 전체 pixel 비교·가장 이른 frame 인수·다른 host·OCR 소비자 교체 완료를 뜻하지 않는다. 나머지는 OCR 제거 checklist에 미완료로 유지한다.
