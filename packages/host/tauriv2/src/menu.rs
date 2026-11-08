//! The Tauri application menu of the menus that the language host library builds from the contract table.

use soksak_host::menu::{Menu, MenuItem};
use tauri::menu::{
    AboutMetadata, IsMenuItem, Menu as TauriMenu, MenuItem as TauriMenuItem, PredefinedMenuItem,
    Submenu,
};
use tauri::{AppHandle, Wry};

/// Builds the Tauri menu of menus. The title of a menu without a title, and the start of the title of an item with the
/// application name, is the application name.
pub(crate) fn application_menu(
    app: &AppHandle,
    menus: Vec<Menu>,
) -> Result<TauriMenu<Wry>, String> {
    let name = app.package_info().name.clone();
    let menu = TauriMenu::new(app).map_err(string)?;
    for submenu in menus {
        let items = submenu
            .items
            .into_iter()
            .map(|item| menu_item(app, &name, item))
            .collect::<Result<Vec<_>, String>>()?;
        let items: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|item| &**item).collect();
        // default: the app menu of the contract table has no title, because its title is the application name.
        let title = submenu.title.unwrap_or_else(|| name.clone());
        let built =
            Submenu::with_id_and_items(app, submenu.id, title, true, &items).map_err(string)?;
        menu.append(&built).map_err(string)?;
    }
    Ok(menu)
}

/// The about panel values of the application.
fn about(app: &AppHandle) -> AboutMetadata<'static> {
    let package = app.package_info();
    let bundle = &app.config().bundle;
    AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: bundle.copyright.clone(),
        authors: bundle.publisher.clone().map(|publisher| vec![publisher]),
        ..Default::default()
    }
}

fn menu_item(
    app: &AppHandle,
    name: &str,
    item: MenuItem,
) -> Result<Box<dyn IsMenuItem<Wry>>, String> {
    fn boxed<T: IsMenuItem<Wry> + 'static>(item: T) -> Box<dyn IsMenuItem<Wry>> {
        Box::new(item)
    }
    match item {
        MenuItem::Separator => PredefinedMenuItem::separator(app).map(boxed),
        MenuItem::Command { id, title, key } => {
            let accelerator = key.map(accelerator).transpose()?;
            TauriMenuItem::with_id(app, id, title, true, accelerator.as_deref()).map(boxed)
        }
        MenuItem::Predefined {
            role,
            title,
            with_app_name,
        } => {
            let title = title.map(|title| {
                if with_app_name {
                    format!("{name} {title}")
                } else {
                    title
                }
            });
            let title = title.as_deref();
            match role {
                "about" => PredefinedMenuItem::about(app, title, Some(about(app))),
                "services" => PredefinedMenuItem::services(app, title),
                "hide" => PredefinedMenuItem::hide(app, title),
                "hide-others" => PredefinedMenuItem::hide_others(app, title),
                "show-all" => PredefinedMenuItem::show_all(app, title),
                // The predefined quit item of the framework sends terminate:, which ends the application without the
                // saves of the host quit, so Quit is an item of the host whose event runs the host quit
                // (docs/spec/hosts.md, Quit request).
                "quit" => {
                    let key = accelerator(soksak_host::menu::item_key("app", "quit")?)?;
                    let title = title.ok_or("the quit item has no title")?;
                    return TauriMenuItem::with_id(app, "quit", title, true, Some(key.as_str()))
                        .map(boxed)
                        .map_err(string);
                }
                "close-window" => PredefinedMenuItem::close_window(app, title),
                "undo" => PredefinedMenuItem::undo(app, title),
                "redo" => PredefinedMenuItem::redo(app, title),
                "cut" => PredefinedMenuItem::cut(app, title),
                "copy" => PredefinedMenuItem::copy(app, title),
                "paste" => PredefinedMenuItem::paste(app, title),
                "select-all" => PredefinedMenuItem::select_all(app, title),
                "fullscreen" => PredefinedMenuItem::fullscreen(app, title),
                "bring-all-to-front" => PredefinedMenuItem::bring_all_to_front(app, title),
                unknown => return Err(format!("the menu has unknown item {unknown:?}")),
            }
            .map(boxed)
        }
    }
    .map_err(string)
}

/// Converts the key format of the contract table (the host.menu report format) into the shortcut format of the menu
/// library of Tauri. The modifier keys are joined with + in the order cmd, shift, ctrl, opt, and the last cell is the key.
pub fn accelerator(key: &str) -> Result<String, String> {
    let parts: Vec<&str> = key.split('+').collect();
    let Some((last, modifiers)) = parts.split_last() else {
        return Err(format!("menu key {key:?} has no key"));
    };
    if last.is_empty() {
        return Err(format!("menu key {key:?} has no key"));
    }
    let mut out: Vec<&str> = Vec::new();
    for modifier in modifiers {
        out.push(match *modifier {
            "cmd" => "CmdOrCtrl",
            "shift" => "Shift",
            "ctrl" => "Control",
            "opt" => "Option",
            unknown => return Err(format!("menu key {key:?} has unknown modifier {unknown:?}")),
        });
    }
    out.push(last);
    Ok(out.join("+"))
}

/// Converts a tauri error into a string error.
fn string(error: tauri::Error) -> String {
    error.to_string()
}
