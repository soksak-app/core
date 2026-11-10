package sok

import "fmt"

// The application identifier (docs/spec/projects.md#persistence) names the default configuration folder and the file of
// the path entry. The release identifier of a Go host is the bundle identifier of its release application, by the
// application name of its framework adapter: the host takes it through IdentityOf with that name, and the sok command
// through Identity with Application, which src/wailsv3.go holds for the Wails host and src/mygo.go, which the mygo tag
// compiles, for the mygo host. A build with the dev tag adds .dev, so a debug build that runs beside the installed
// application does not use its data; a diagnostic release without the tag keeps the release identifier.

// releaseIdentifiers are the release identifiers of the Go hosts by application name.
var releaseIdentifiers = map[string]string{"wailsv3": "app.soksak.wails", "mygo": "app.soksak.mygo"}

// ReleaseIdentifier is the release identifier of the host of this sok command.
var ReleaseIdentifier = releaseIdentifiers[Application]

// devBuild is set by the init of a build with the dev tag.
var devBuild bool

// IdentityOf is the identifier of this build for the Go host whose application name is application.
func IdentityOf(application string) (string, error) {
	release, ok := releaseIdentifiers[application]
	if !ok {
		return "", fmt.Errorf("no Go host has the application name %q", application)
	}
	if devBuild {
		return release + ".dev", nil
	}
	return release, nil
}

// Identity is the identifier of this build of the sok command.
func Identity() string {
	identifier, err := IdentityOf(Application)
	if err != nil {
		panic(err) // Application is a key of releaseIdentifiers: TestEachGoHostHasTheIdentifierOfItsApplication.
	}
	return identifier
}
