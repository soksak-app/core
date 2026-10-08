package sok

// The application identifier (docs/spec/projects.md#persistence) names the default configuration folder and the file of
// the path entry. A build with the dev tag adds .dev, so a debug build that runs beside the installed application does
// not use its data; a diagnostic release without the tag keeps the release identifier.

// ReleaseIdentifier 는 release build 의 식별자이며 번들 식별자다.
const ReleaseIdentifier = "app.soksak.wails"

// devBuild is set by the init of a build with the dev tag.
var devBuild bool

// Identity 는 이 build 의 식별자다.
func Identity() string {
	if devBuild {
		return ReleaseIdentifier + ".dev"
	}
	return ReleaseIdentifier
}
