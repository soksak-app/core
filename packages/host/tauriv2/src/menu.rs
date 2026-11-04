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
        MenuItem::Command {
            id,
            title,
            accelerator,
        } => TauriMenuItem::with_id(app, id, title, true, accelerator.as_deref()).map(boxed),
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
                "quit" => PredefinedMenuItem::quit(app, title),
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

/// Converts a tauri error into a string error.
fn string(error: tauri::Error) -> String {
    error.to_string()
}
