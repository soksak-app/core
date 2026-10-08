# Projects, settings, and windows

[한국어](projects.ko.md)

The independent window declaration, placement, association and rail-border contract is [external window sidebars](external-sidebars.md). The internal card-side contract remains independent.

This specification defines the application project registry, persistent settings, and project windows. [Features](../features.md) records implementation and validation separately.

## Project identity

A project represents one existing directory. Native hosts expand the current user's `~`, resolve an absolute path and symbolic links, require a directory, and report its filesystem identity. The project registry rejects duplicate identities and duplicate canonical paths. Opening the same directory again selects its existing project and window; it does not create another project. Project names are editable and do not determine identity.

Application startup and the New Window action display the project library in an ordinary application window with no selected project. Creating or opening the first project replaces the library with its workspace in that same OS window. A library is a screen, not a separate window type or a placeholder project. Reloading an existing workspace retains that window's selected project. A missing directory produces a visible error without deleting its saved project data; project selection remains available.

The library has two pages, 프로젝트 and 플러그인, selected by the tabs at the start of its heading (`core.library.page`); this specification defines 프로젝트, and [plugin screen](installation.md#plugin-screen) defines 플러그인. The 프로젝트 page displays saved projects, layout previews, folder paths, space counts, pinned projects, last-opened times, and actual open-project status. Search matches names and paths. The project grid uses the full content width. The library has no navigation sidebar, category filters, standalone Open Folder action, or Git Clone action. New Project creates a named directory under a selected parent. File-dialog cancellation and operation failure leave the current screen available. The browser example registers a typed folder path and supports project selection and browser windows, but cannot create native directories.

Layout previews are schematic diagrams of the active space's saved card grid. They preserve card order, grid spans, and split directions, with uniform gaps, equally sized row tracks, and compact sidebar columns. Content columns share the remaining width equally. Theme-derived colors, rounded corners, and small content symbols distinguish panes. Window dimensions, dragged split ratios, fixed pixel widths, and rail outlines do not determine thumbnail proportions. Preview generation uses saved layout state without opening the workspace or storing rendered coordinates. It does not create content webviews or shells.

The title bar’s project-list button and project-add action open the library in that window while preserving its current work. Selecting a project or returning to the workspace restores the work screen. New Window always creates an unassigned window. On macOS, closing all windows keeps the application available for this action. The library footer, Command/Ctrl+Shift+N, and macOS Dock menu invoke the same action. The library always uses common settings, including when returning from a project workspace. Returning to the workspace reapplies that project’s overrides.

A terminal or shell surface opened in a project starts in the project's canonical root unless it was split from a surface that reported a directory ([tab reports](plugins.md#tab-reports)).

## Shared appearance

The library and project workspace use the same typography, color, border, corner, and spacing definitions in `app.css`. `library.css` defines the library layout and its component placement. It does not define a separate type scale or fixed theme colors and corner radii.

The configured font family and base size apply to both screens. At the default 13px base size, project names and controls use 12px, secondary content uses 11px, and metadata and status text use 10px. These sizes scale with the base size. Body and control text use the same line height and normal letter spacing; section captions share one letter-spacing value. Screen headings use the base size rather than a separate large display style.

Library controls, forms, project cards, and the footer use the workspace's compact spacing and theme-derived borders and corners. Changing font, size, theme, or corner settings applies the same definitions in both screens.

## Settings

The library applies defaults and common settings only. A project workspace additionally applies its project’s explicit overrides. The selected settings project determines effective values, default write targets, and available scopes. The library clears this selection while preserving the window’s projects and their saved overrides. Workspace selection restores the settings project.

Every settings section provides horizontal Global and Project scope tabs above its controls ([settings window](settings.md)). The left navigation contains setting categories only. The library provides only Global; Global and Project are available in a project workspace. Returning to the library resets the editing scope to Global without changing the project’s saved overrides. Selecting another category preserves the chosen scope for its controls. A project value can be removed to resume inheriting the common value. Changing a common value updates every open project that has no override for that value.

Project opening mode is common-only: `tabs` opens projects in the current window, and `windows` opens another project in a separate top-level OS window when the current window already owns a project. An unassigned window always opens its first project in place. Project-folder settings cannot override this mode; `core.settings.set` with this key in the project scope fails with -32602 (invalid params) and changes nothing. Existing project windows are reused when their project is selected; changing the opening policy applies to subsequent project opens and does not close running windows or shells.

Project windows are independent OS windows. Settings and add/split menus remain in-window native webviews governed by [native modals](native-modals.md). Each project window owns its active project, surfaces, modal, theme, input state, and shell subscriptions. One window's layout preparation, reload, settings, or closure must not alter another window's native state.

Removing a project from the registry, by its project tab's × or by the library's remove button (`core.library.remove`) in any window, ends that project in the window that shows it, the same way in each case. That window reads the removal from the registry change notification. It disposes the surface modules of the project's tabs, then ends their sidecar sessions ([terminal runtime](terminal-runtime.md#closing-and-recovery)), and opens its first remaining project. A window that shows no other project shows the library in the same OS window and stays open as a window without a project: `host.windows` reports it with `project` null, and `core.projects` no longer lists the removed project. Closing a window's last project tab has the same result.

## Persistence

The application persists the ordered project registry, common settings, folder overrides, spaces, active space, card and tab state, focused card, sidebar and card sidebar widths (including hidden sidebars), the selected tab and folded sections of each sidebar, and project window size and position. Window ownership and live shell processes are runtime state. Closing a project window preserves its saved project and screen settings.

Native hosts load common settings from `settings.json` in the application configuration directory and project overrides from `.soksak/settings.json` inside the project directory. Missing settings files contain no overrides. The project file contains only explicit overrides; removing a key resumes inheritance. The common-only keys `projectOpening` and `textSize` are not accepted in project settings: a project settings file with one of them fails the snapshot with `<path>: <key> is common-only`, and a project write fails with `<key> is common-only`. The frame text factor is common-only because the host sets a window's title bar from it before the page starts ([title bar height](native-surfaces.md#title-bar-height)).

The default configuration directories are:

| Host | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Wails | `~/Library/Application Support/app.soksak.wails` | `%AppData%/app.soksak.wails` | `$XDG_CONFIG_HOME/app.soksak.wails`, or `~/.config/app.soksak.wails` when unset |
| Tauri | `~/Library/Application Support/app.soksak.tauri` | `%AppData%/app.soksak.tauri` | `$XDG_CONFIG_HOME/app.soksak.tauri`, or `~/.config/app.soksak.tauri` when unset |

The directory name is the application identifier. Builds with the `dev` flag (the Go tag and the Cargo feature `dev`), which the debug targets make, append `.dev` (`app.soksak.wails.dev`, `app.soksak.tauri.dev`), so a development build never reads or writes the data of a release application; a diagnostic release, which is built without `dev`, keeps the release identifier. The command-line package of each language holds the identifier (`packages/sok/<app>/src/identity.*`), and the host uses it.

`--config-dir PATH` selects another application configuration directory. The host rejects an empty path, creates missing directories of the path with mode 0700 (owner only), keeps the mode of an existing directory, and uses the canonical path. Project override paths remain inside their projects. Global edits update the common settings file; Project edits update the selected project's settings file. **Use global value** removes an individual override. Project tabs can be reordered by dragging; their order determines the default library order. A tab's × removes the project from the registry and preserves its folder and settings file. The OS window's close button preserves the project in the registry.

The application configuration directory also contains `projects.json`, which stores the ordered registry, project screen state, and each project's plugin data under `plugins` ([project data](plugins.md#project-data)). Wails and Tauri use their own application configuration directories. Native hosts serialize changes, reread the affected file before updating it, write a temporary file in the same directory, and replace the destination after the write completes. Open windows receive a change notification after successful replacement. Settings files are reread on reload and project selection. A storage failure is reported visibly; it does not reset or silently overwrite saved data with defaults. Closing a ready project window completes pending saves before closing its native resources. A main-page reload asks a ready page to complete its pending saves (`core.projects.flush`) before it replaces the page. Application quit requests the same save from each ready window before termination.

Opening a space validates its content tabs, active tab, fixed sidebar IDs and `{width}` records before replacing the displayed layout. The stored layout is read only in its current form: a layout that holds `edgeWidth` or `railWidth`, a card whose data holds `panels` or `sidebar`, or a sidebar choice stored under a content card's ID fails with an error that names `projects.json`, the project root, the space and what it found, and it is not converted. Tabs of plugins that are not loaded open as placeholder cards ([plugins](plugins.md#plugins-that-are-not-loaded)). Empty content tabs, persistent owner fields, plugin-specific sidebar IDs and obsolete rail cards fail explicitly with their reason, which the library preview shows. Stored sidebar settings fail on unregistered sections or invalid links ([settings window](settings.md#stored-sets-and-links)). A library preview applies the same validation to the active space of each project; a project whose saved layout fails shows that error instead of a preview and reports it in `core.library` `previewErrors`. Explicit null width or section-choice records are invalid; only an absent optional field has the declared empty-record default.

A space's layout stores `sidebars`: for each sidebar id (`left`, `right`, or `cardId:side` for an internal card sidebar) `{tab, folded}`, the selected section id of a `tabs` set or `null`, and the folded section ids of a `list` set. Keep choices per space. An override changes the content of the same fixed sidebar, not its identity. A choice changes the saved space like any other layout change. A layout without `sidebars` has no stored choice; retained section choices apply only when that section is in the selected set.

The browser example uses browser windows and IndexedDB storage; it does not write settings into native folders. It cannot establish native filesystem identity from a typed path; directory identity and native window placement require a native host.

## Acceptance

- Equivalent folder paths and symbolic links select one project, including concurrent opens from separate windows.
- Project creation, renaming, removal, order, pins, and last-opened times survive application restart; startup displays the library without starting projects.
- The library always uses and edits common settings, including after leaving a workspace with project overrides. Returning to the workspace restores its overrides and provides both editing scopes.
- Common settings and explicit folder overrides survive reload and restart. Resetting an override restores inheritance. The opening mode is absent from project-folder settings.
- Startup and New Window show the library without native content surfaces or shells. First-project creation/opening reuses that OS window in both opening modes. Selecting another project from an occupied window follows the common opening mode. Reopening an already open project selects its existing window.
- Layout, tabs, sidebar widths, theme settings, and normal window geometry restore for the selected project. Closing a window keeps its saved data.
- A saved space that names unregistered plugins fails to open with the validation error, and its library preview shows the same error; the saved record is not changed.
- A project whose folder the host cannot read shows the reason under the folder path of its library card, and `core.library` reports the host's message under `folderErrors`. Both hosts use the messages of [`workspace.folder.messages`](host-contract.md); the card shows the declared ones as a reason without the path (missing folder, no read permission, a file) and any other message as it is; the library asks the host again each time it is shown and each time the registry changes. The card's open button is disabled, and opening that project by command fails with the host's message. The record stays in the library until the user removes it with the card's remove button (`core.library.remove`), which deletes the record and its spaces like closing a project tab and leaves the folder unchanged. The window that shows the removed project ends it as the project window rules in [settings](#settings) define for a removal.
- Two windows can render and receive input independently. Settings effects, native surfaces, shells, and cleanup remain limited to their owning window.
- Existing surface placement, fractional rendering, and modal checks continue to pass in both native hosts. Native behavior on each operating system is recorded separately.
