package sok

// 애플리케이션 식별자(docs/spec/projects.md#persistence). 식별자는 기본 설정 폴더의 이름이고 경로 항목의 파일
// 이름이다. 진단 build 는 release 애플리케이션의 데이터를 쓰지 않도록 .dev 를 붙인다.

// ReleaseIdentifier 는 release build 의 식별자이며 번들 식별자다.
const ReleaseIdentifier = "app.soksak.wails"

// diagnosticBuild 는 진단 build 의 init 이 true 로 정한다.
var diagnosticBuild bool

// Identity 는 이 build 의 식별자다.
func Identity() string {
	if diagnosticBuild {
		return ReleaseIdentifier + ".dev"
	}
	return ReleaseIdentifier
}
