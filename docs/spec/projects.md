# Projects, settings, and windows

[한국어](projects.ko.md)

This specification defines the application project registry, persistent settings, and project windows. [Features](../features.md) records implementation and validation separately.

## Project identity

A project represents one existing directory. Native hosts expand the current user's `~`, resolve an absolute path and symbolic links, require a directory, and report its filesystem identity. The project registry rejects duplicate identities and duplicate canonical paths. Opening the same directory again selects its existing project and window; it does not create another project. Project names are editable and do not determine identity.

The saved project order determines startup selection. Application startup opens only the first project in that order, regardless of which project was last active. If no project is registered, the application displays the project-add action. A missing directory produces a visible error without deleting its saved project data; the project selector remains available.

## Settings

Effective settings are defaults, then common settings, then the current project's explicit overrides. Settings provides a common scope and a project-folder scope. A project value can be removed to resume inheriting the common value. Changing a common value updates every open project that has no override for that value.

Project opening mode is common-only: `tabs` opens projects in the current window, and `windows` opens each newly opened project in a separate top-level OS window. Project-folder settings cannot override this mode. Existing project windows are reused when their project is selected; changing the opening policy applies to subsequent project opens and does not close running windows or shells.

Project windows are independent OS windows. Settings and add/split menus remain in-window native webviews governed by [native modals](native-modals.md). Each project window owns its active project, surfaces, modal, theme, input state, and shell subscriptions. One window's layout preparation, reload, settings, or closure must not alter another window's native state.

## Persistence

The application persists the ordered project registry, common settings, folder overrides, spaces, active space, card and tab state, focused card, sidebar and rail widths (including hidden sidebars), and project window size and position. Window ownership and live shell processes are runtime state. Closing a project window preserves its saved project and screen settings.

Native hosts load common settings from `settings.json` in the application configuration directory and project overrides from `.soksak/settings.json` inside the project directory. Missing settings files contain no overrides. The project file contains only explicit overrides; removing a key resumes inheritance. The common-only `projectOpening` key is not accepted in project settings.

The default configuration directories are:

| Host | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Wails | `~/Library/Application Support/com.soksak.wailsv3` | `%AppData%/com.soksak.wailsv3` | `$XDG_CONFIG_HOME/com.soksak.wailsv3`, or `~/.config/com.soksak.wailsv3` when unset |
| Tauri | `~/Library/Application Support/dev.soksak.example` | `%AppData%/dev.soksak.example` | `$XDG_CONFIG_HOME/dev.soksak.example`, or `~/.config/dev.soksak.example` when unset |

`--config-dir PATH` selects another application configuration directory. Project override paths remain inside their projects. The settings UI provides a common/project scope selector and removes individual overrides through **Use common value**. Project tabs can be reordered by dragging; their order determines startup selection. A tab's × removes the project from the registry and preserves its folder and settings file. The OS window's close button preserves the project in the registry.

The application configuration directory also contains `projects.json`, which stores the ordered registry and project screen state. Wails and Tauri use their own application configuration directories. Native hosts serialize changes, reread the affected file before updating it, write a temporary file in the same directory, and replace the destination after the write completes. Open windows receive a change notification after successful replacement. Settings files are reread on reload and project selection. A storage failure is reported visibly; it does not reset or silently overwrite saved data with defaults. Closing a ready project window completes pending saves before closing its native resources. Application quit requests the same save from each ready window before termination.

The browser example uses browser windows and IndexedDB storage; it does not write settings into native folders. It cannot establish native filesystem identity from a typed path; directory identity and native window placement require a native host.

## Acceptance

- Equivalent folder paths and symbolic links select one project, including concurrent opens from separate windows.
- Project creation, renaming, removal, and order survive application restart; startup selects the first remaining project.
- Common settings and explicit folder overrides survive reload and restart. Resetting an override restores inheritance. The opening mode is absent from project-folder settings.
- Selecting `windows` opens a new project's content in a separate OS window. Reopening that project selects its existing window.
- Layout, tabs, sidebar widths, theme settings, and normal window geometry restore for the selected project. Closing a window keeps its saved data.
- Two windows can render and receive input independently. Settings effects, native surfaces, shells, and cleanup remain limited to their owning window.
- Existing surface placement, fractional rendering, and modal checks continue to pass in both native hosts. Native behavior on each operating system is recorded separately.
