package sok

// The application identifier (docs/spec/projects.md#persistence) names the default configuration folder and the file of
// the path entry. A build with the dev tag adds .dev, so a debug build that runs beside the installed application does
// not use its data; a diagnostic release without the tag keeps the release identifier.

// ReleaseIdentifier is the identifier of the release build and is the bundle identifier.
const ReleaseIdentifier = "app.soksak.wails"

// devBuild is set by the init of a build with the dev tag.
var devBuild bool

// Identity is the identifier of this build.
func Identity() string {
	if devBuild {
		return ReleaseIdentifier + ".dev"
	}
	return ReleaseIdentifier
}
