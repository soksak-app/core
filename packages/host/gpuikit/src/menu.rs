//! The application menu of GPUI: the menus of the language host library as NSMenu items whose actions reach the
//! menu event of the host.

use std::sync::Mutex;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{AnyThread, DefinedClass as _, define_class};
use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
use objc2_foundation::{MainThreadMarker, NSString};
use soksak_host::framework::AppHandle;
use soksak_host::menu::{Menu, MenuItem};

/// The calls of the items of the installed menu, in the order of their targets.
static CALLS: Mutex<Vec<Box<dyn Fn() + Send + Sync>>> = Mutex::new(Vec::new());

/// The target objects of the items of the installed menu, which outlive the menu that holds them.
static TARGETS: Mutex<Vec<Retained<ItemTarget>>> = Mutex::new(Vec::new());

// The target of one item of the host, whose action runs the call of the menu table.
define_class!(
    #[unsafe(super(objc2_foundation::NSObject))]
    #[thread_kind = AnyThread]
    #[ivars = usize]
    struct ItemTarget;

    impl ItemTarget {
        #[unsafe(method(select:))]
        unsafe fn select(&self, _sender: *mut AnyObject) {
            let index = *self.ivars();
            let calls = crate::frontend::locked(&CALLS, "menu calls");
            if let Some(call) = calls.get(index) {
                call();
            }
        }
    }
);

/// Builds the application menu of menus and installs it. The title of a menu without a title, and the start of the
/// title of an item with the application name, is the application name.
pub(crate) fn set_menu(app: &AppHandle, menus: Vec<Menu>) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("the menu is installed on the main thread")?;
    let application = NSApplication::sharedApplication(mtm);
    let name = "Soksak";
    *crate::frontend::locked(&CALLS, "menu calls") = Vec::new();
    *crate::frontend::locked(&TARGETS, "menu targets") = Vec::new();
    let bar = NSMenu::new(mtm);
    bar.setAutoenablesItems(false);
    for submenu in menus {
        let menu = NSMenu::new(mtm);
        menu.setTitle(&NSString::from_str(
            // default: a menu without a title takes the application name, as packages/host/tauriv2/src/menu.rs:25-26 does.
            &submenu.title.unwrap_or_else(|| name.to_string()),
        ));
        for item in submenu.items {
            let item = menu_item(app, &application, mtm, name, item)?;
            menu.addItem(&item);
        }
        let item = NSMenuItem::new(mtm);
        item.setTitle(&menu.title());
        item.setSubmenu(Some(&menu));
        bar.addItem(&item);
    }
    application.setMainMenu(Some(&bar));
    Ok(())
}

/// One item of the menu model as an NSMenuItem.
fn menu_item(
    app: &AppHandle,
    application: &NSApplication,
    mtm: MainThreadMarker,
    name: &str,
    item: MenuItem,
) -> Result<Retained<NSMenuItem>, String> {
    if matches!(item, MenuItem::Separator) {
        return Ok(NSMenuItem::separatorItem(mtm));
    }
    let view = NSMenuItem::new(mtm);
    let (title, key, call) = match item {
        MenuItem::Separator => unreachable!("the separator returned before"),
        MenuItem::Command { id, title, key } => {
            let event_app = app.clone();
            (
                Some(title),
                key,
                Some(Box::new(move || soksak_host::menu_event(&event_app, id))
                    as Box<dyn Fn() + Send + Sync>),
            )
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
            let selector: objc2::runtime::Sel = match role {
                "services" => {
                    // The system fills the services menu; the item holds the menu that the application
                    // names as its services menu.
                    let menu = NSMenu::new(mtm);
                    application.setServicesMenu(Some(&menu));
                    view.setSubmenu(Some(&menu));
                    return Ok(view);
                }
                "about" => objc2::sel!(orderFrontStandardAboutPanel:),
                "hide" => objc2::sel!(hide:),
                "hide-others" => objc2::sel!(hideOtherApplications:),
                "show-all" => objc2::sel!(unhideAllApplications:),
                "close-window" => objc2::sel!(performClose:),
                "undo" => objc2::sel!(undo:),
                "redo" => objc2::sel!(redo:),
                "cut" => objc2::sel!(cut:),
                "copy" => objc2::sel!(copy:),
                "paste" => objc2::sel!(paste:),
                "select-all" => objc2::sel!(selectAll:),
                "fullscreen" => objc2::sel!(toggleFullScreen:),
                "bring-all-to-front" => objc2::sel!(arrangeInFront:),
                // The predefined quit item of the framework sends terminate:, which ends the application without
                // the saves of the host quit, so Quit is an item of the host whose event runs the host quit
                // (docs/spec/hosts.md, Quit request).
                "quit" => {
                    let key = soksak_host::menu::item_key("app", "quit")?;
                    let title = title.ok_or("the quit item has no title")?;
                    let quit = app.clone();
                    let target = target_of(
                        mtm,
                        Some(Box::new(move || quit.quit()) as Box<dyn Fn() + Send + Sync>),
                    )?;
                    unsafe {
                        view.setTitle(&NSString::from_str(&title));
                        let (equivalent, mask) = key_equivalent(key)?;
                        view.setKeyEquivalent(&NSString::from_str(&equivalent));
                        view.setKeyEquivalentModifierMask(mask);
                        view.setAction(Some(objc2::sel!(select:)));
                        view.setTarget(Some(&target));
                    }
                    return Ok(view);
                }
                unknown => return Err(format!("the menu has unknown item {unknown:?}")),
            };
            return Ok(unsafe {
                if let Some(title) = title {
                    view.setTitle(&NSString::from_str(&title));
                }
                view.setAction(Some(selector));
                view.setTarget(None);
                view
            });
        }
    };
    let target = target_of(mtm, call)?;
    unsafe {
        if let Some(title) = title {
            view.setTitle(&NSString::from_str(&title));
        }
        if let Some(key) = key {
            let (equivalent, mask) = key_equivalent(key)?;
            view.setKeyEquivalent(&NSString::from_str(&equivalent));
            view.setKeyEquivalentModifierMask(mask);
        }
        view.setAction(Some(objc2::sel!(select:)));
        view.setTarget(Some(&target));
    }
    Ok(view)
}

/// Allocates the target of one item of the host with its call.
fn target_of(
    _mtm: MainThreadMarker,
    call: Option<Box<dyn Fn() + Send + Sync>>,
) -> Result<Retained<ItemTarget>, String> {
    let index = {
        let mut calls = crate::frontend::locked(&CALLS, "menu calls");
        calls.push(call.expect("an item of the host holds a call"));
        calls.len() - 1
    };
    let allocated = ItemTarget::alloc().set_ivars(index);
    // default: the init of NSObject is the designated initializer of the target.
    let target: Retained<ItemTarget> = unsafe { objc2::msg_send![super(allocated), init] };
    crate::frontend::locked(&TARGETS, "menu targets").push(target.clone());
    Ok(target)
}

/// Converts the key format of the contract table (the host.menu report format) into the key equivalent and the
/// modifier mask of AppKit. The modifier keys are joined with + in the order cmd, shift, ctrl, opt, and the last
/// cell is the key.
pub fn key_equivalent(key: &str) -> Result<(String, objc2_app_kit::NSEventModifierFlags), String> {
    let parts: Vec<&str> = key.split('+').collect();
    let Some((last, modifiers)) = parts.split_last() else {
        return Err(format!("menu key {key:?} has no key"));
    };
    if last.is_empty() {
        return Err(format!("menu key {key:?} has no key"));
    }
    let mut mask = objc2_app_kit::NSEventModifierFlags::empty();
    for modifier in modifiers {
        mask |= match *modifier {
            "cmd" => objc2_app_kit::NSEventModifierFlags::Command,
            "shift" => objc2_app_kit::NSEventModifierFlags::Shift,
            "ctrl" => objc2_app_kit::NSEventModifierFlags::Control,
            "opt" => objc2_app_kit::NSEventModifierFlags::Option,
            unknown => return Err(format!("menu key {key:?} has unknown modifier {unknown:?}")),
        };
    }
    Ok((last.to_string(), mask))
}
