# Projects, settings, and windows

[한국어](projects.ko.md)

This specification defines the application project registry, persistent settings, and project windows. [Features](../features.md) records implementation and validation separately.

## Project identity

A project represents one existing directory. Native hosts expand the current user's `~`, resolve an absolute path and symbolic links, require a directory, and report its filesystem identity. The project registry rejects duplicate identities and duplicate canonical paths. Opening the same directory again selects its existing project and window; it does not create another project. Project names are editable and do not determine identity.

Application startup and the New Window action display the project library in an ordinary application window with no selected project. Creating or opening the first project replaces the library with its workspace in that same OS window. A library is a screen, not a separate window type or a placeholder project. Reloading an existing workspace retains that window's selected project. A missing directory produces a visible error without deleting its saved project data; project selection remains available.

The library displays saved projects, layout previews, folder paths, space counts, pinned projects, last-opened times, and actual open-project status. Search matches names and paths. The project grid uses the full content width. The library has no navigation sidebar, category filters, standalone Open Folder action, or Git Clone action. New Project creates a named directory under a selected parent. File-dialog cancellation and operation failure leave the current screen available. The browser example registers a typed folder path and supports project selection and browser windows, but cannot create native directories.

Layout previews are schematic diagrams of the active space's saved card grid. They preserve card order, grid spans, and split directions, with uniform gaps, equally sized row tracks, and compact sidebar columns. Content columns share the remaining width equally. Theme-derived colors, rounded corners, and small content symbols distinguish panes. Window dimensions, dragged split ratios, fixed pixel widths, and rail outlines do not determine thumbnail proportions. Preview generation uses saved layout state without opening the workspace or storing rendered coordinates. It does not create content webviews or shells.

The title bar’s project-list button and project-add action open the library in that window while preserving its current work. Selecting a project or returning to the workspace restores the work screen. New Window always creates an unassigned window. On macOS, closing all windows keeps the application available for this action. The library footer, Command/Ctrl+Shift+N, and macOS Dock menu invoke the same action. The library always uses common settings, including when returning from a project workspace. Returning to the workspace reapplies that project’s overrides.

## Shared appearance

The library and project workspace use the same typography, color, border, corner, and spacing definitions in `app.css`. `library.css` defines the library layout and its component placement. It does not define a separate type scale or fixed theme colors and corner radii.

The configured font family and base size apply to both screens. At the default 13px base size, project names and controls use 12px, secondary content uses 11px, and metadata and status text use 10px. These sizes scale with the base size. Body and control text use the same line height and normal letter spacing; section captions share one letter-spacing value. Screen headings use the base size rather than a separate large display style.

Library controls, forms, project cards, and the footer use the workspace's compact spacing and theme-derived borders and corners. Changing font, size, theme, or corner settings applies the same definitions in both screens.

## Settings

The library applies defaults and common settings only. A project workspace additionally applies its project’s explicit overrides. The selected settings project determines effective values, default write targets, and available scopes. The library clears this selection while preserving the window’s projects and their saved overrides. Workspace selection restores the settings project.

The General settings pane provides horizontal Global and Project scope tabs above its controls. The left navigation contains setting categories only. The library provides only Global; Global and Project are available in a project workspace. Returning to the library resets the editing scope to Global without changing the project’s saved overrides. Selecting another category preserves the chosen scope for its controls. A project value can be removed to resume inheriting the common value. Changing a common value updates every open project that has no override for that value.

Project opening mode is common-only: `tabs` opens projects in the current window, and `windows` opens another project in a separate top-level OS window when the current window already owns a project. An unassigned window always opens its first project in place. Project-folder settings cannot override this mode. Existing project windows are reused when their project is selected; changing the opening policy applies to subsequent project opens and does not close running windows or shells.

Project windows are independent OS windows. Settings and add/split menus remain in-window native webviews governed by [native modals](native-modals.md). Each project window owns its active project, surfaces, modal, theme, input state, and shell subscriptions. One window's layout preparation, reload, settings, or closure must not alter another window's native state.

## Persistence

The application persists the ordered project registry, common settings, folder overrides, spaces, active space, card and tab state, focused card, sidebar and rail widths (including hidden sidebars), and project window size and position. Window ownership and live shell processes are runtime state. Closing a project window preserves its saved project and screen settings.

Native hosts load common settings from `settings.json` in the application configuration directory and project overrides from `.soksak/settings.json` inside the project directory. Missing settings files contain no overrides. The project file contains only explicit overrides; removing a key resumes inheritance. The common-only `projectOpening` key is not accepted in project settings.

The default configuration directories are:

| Host | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Wails | `~/Library/Application Support/com.soksak.wailsv3` | `%AppData%/com.soksak.wailsv3` | `$XDG_CONFIG_HOME/com.soksak.wailsv3`, or `~/.config/com.soksak.wailsv3` when unset |
| Tauri | `~/Library/Application Support/dev.soksak.example` | `%AppData%/dev.soksak.example` | `$XDG_CONFIG_HOME/dev.soksak.example`, or `~/.config/dev.soksak.example` when unset |

`--config-dir PATH` selects another application configuration directory. Project override paths remain inside their projects. Global edits update the common settings file; Project edits update the selected project's settings file. **Use global value** removes an individual override. Project tabs can be reordered by dragging; their order determines the default library order. A tab's × removes the project from the registry and preserves its folder and settings file. The OS window's close button preserves the project in the registry.

The application configuration directory also contains `projects.json`, which stores the ordered registry and project screen state. Wails and Tauri use their own application configuration directories. Native hosts serialize changes, reread the affected file before updating it, write a temporary file in the same directory, and replace the destination after the write completes. Open windows receive a change notification after successful replacement. Settings files are reread on reload and project selection. A storage failure is reported visibly; it does not reset or silently overwrite saved data with defaults. Closing a ready project window completes pending saves before closing its native resources. Application quit requests the same save from each ready window before termination.

The browser example uses browser windows and IndexedDB storage; it does not write settings into native folders. It cannot establish native filesystem identity from a typed path; directory identity and native window placement require a native host.

## Acceptance

- Equivalent folder paths and symbolic links select one project, including concurrent opens from separate windows.
- Project creation, renaming, removal, order, pins, and last-opened times survive application restart; startup displays the library without starting projects.
- The library always uses and edits common settings, including after leaving a workspace with project overrides. Returning to the workspace restores its overrides and provides both editing scopes.
- Common settings and explicit folder overrides survive reload and restart. Resetting an override restores inheritance. The opening mode is absent from project-folder settings.
- Startup and New Window show the library without native content surfaces or shells. First-project creation/opening reuses that OS window in both opening modes. Selecting another project from an occupied window follows the common opening mode. Reopening an already open project selects its existing window.
- Layout, tabs, sidebar widths, theme settings, and normal window geometry restore for the selected project. Closing a window keeps its saved data.
- Two windows can render and receive input independently. Settings effects, native surfaces, shells, and cleanup remain limited to their owning window.
- Existing surface placement, fractional rendering, and modal checks continue to pass in both native hosts. Native behavior on each operating system is recorded separately.
