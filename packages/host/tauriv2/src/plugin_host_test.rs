//! The plugin host web views of a window against fakes at the platform boundary (docs/spec/plugin-host.md).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::plugin_host::{
    self, Failure, HostPlugin, HostState, HostView, PluginHostRestarts, PluginHosts,
};
use crate::plugin_host_channel::clear_enabled_stop;
use crate::test_folder::Folder;

/// The record of the platform fake: the created host webviews with their configuration, the addresses that they load,
/// and the handles that are closed.
#[derive(Default)]
struct Fake {
    created: Vec<(String, String, String, String)>,
    loaded: Vec<String>,
    closed: Vec<usize>,
}

impl Fake {
    /// Records one created host webview with its configuration and returns its handle, as the platform boundary does.
    fn create(&mut self, channel: &str, view: &HostView<'_>) -> usize {
        self.created.push((
            (self.created.len() + 1).to_string(),
            view.directory.to_string(),
            view.folder.to_string(),
            format!("{} {channel}", view.plugin),
        ));
        self.created.len()
    }

    /// Records the address that a created host webview loads, as the platform boundary does.
    fn load(&mut self, address: &str) {
        self.loaded.push(address.to_string());
    }

    /// Records one closed host webview handle, as the platform boundary does.
    fn close(&mut self, handle: usize) {
        self.closed.push(handle);
    }
}

/// A configuration folder with one enabled plugin probe, whose manifest declares host, and one enabled plugin plain,
/// whose manifest declares none.
fn host_fixture() -> Folder {
    let config = Folder::new();
    for (name, content) in [
        (
            "plugins/installed.json",
            r#"{"format": 3, "plugins": {
            "probe": {"version": "0.1.0", "path": "plugins/probe/0.1.0", "enabled": true, "sidecars": {}},
            "plain": {"version": "0.1.0", "path": "plugins/plain/0.1.0", "enabled": true, "sidecars": {}}},
            "sidecars": {}}"#,
        ),
        (
            "plugins/probe/0.1.0/package.json",
            r#"{"name": "plugin-probe"}"#,
        ),
        (
            "plugins/probe/0.1.0/plugin.json",
            r#"{"id": "probe", "host": {"page": "ui/host.html"}}"#,
        ),
        (
            "plugins/plain/0.1.0/package.json",
            r#"{"name": "plugin-plain"}"#,
        ),
        ("plugins/plain/0.1.0/plugin.json", r#"{"id": "plain"}"#),
    ] {
        let file = config.path().join(name);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, content).unwrap();
    }
    config
}

// contract: plugin-host.create-loads-page
#[test]
fn the_host_creates_the_host_webview_of_a_plugin_that_declares_host_and_loads_its_page() {
    let config = host_fixture();
    let plugins =
        plugin_host::host_plugins(config.path()).expect("the host reads the host plugins");
    assert_eq!(
        plugins,
        vec![HostPlugin {
            id: "probe".into(),
            page: "ui/host.html".into(),
            state: None
        }],
        "only probe declares host"
    );
    let fake = std::cell::RefCell::new(Fake::default());
    let view = HostView {
        directory: "/config/document-data",
        folder: "/config/plugins/probe/0.1.0",
        plugin: &plugins[0].id,
        page: &plugins[0].page,
    };
    let handle = plugin_host::create_host(
        "channel-script",
        view,
        |channel, view| Ok(fake.borrow_mut().create(channel, view)),
        |_handle, address| {
            fake.borrow_mut().load(address);
            Ok(true)
        },
        |handle| {
            fake.borrow_mut().close(handle);
            Ok(())
        },
    )
    .expect("the host webview of probe is created");
    let fake = fake.into_inner();
    assert_eq!(
        fake.created,
        vec![(
            "1".to_string(),
            "/config/document-data".to_string(),
            "/config/plugins/probe/0.1.0".to_string(),
            "probe channel-script".to_string(),
        )],
        "the creation receives the data directory, the folder, the plugin and the channel script of the view configuration"
    );
    assert_eq!(fake.loaded, vec!["sok://probe/ui/host.html".to_string()]);
    assert!(
        fake.closed.is_empty(),
        "a created host webview is not closed"
    );
    assert_eq!(handle, 1);
}

// contract: plugin-host.create-once-per-plugin
#[test]
fn the_host_creates_one_host_webview_per_plugin_per_window() {
    let hosts = PluginHosts::default();
    let plugins = vec![HostPlugin {
        id: "probe".into(),
        page: "ui/host.html".into(),
        state: None,
    }];
    assert_eq!(
        hosts.missing(&plugins, &PluginHostRestarts::default()),
        plugins,
        "the first readiness wants the host of probe"
    );
    hosts.insert("probe", 1);
    assert!(
        hosts
            .missing(&plugins, &PluginHostRestarts::default())
            .is_empty(),
        "a second readiness creates no further host webview"
    );
}

// contract: plugin-host.change-disposes
#[test]
fn the_disposal_of_a_plugin_ends_its_host_webview_once() {
    let hosts = PluginHosts::default();
    hosts.insert("probe", 1);
    assert_eq!(
        hosts.take("probe"),
        Some(1),
        "the removal of the plugin takes its host webview"
    );
    assert_eq!(
        hosts.take("probe"),
        None,
        "the record of the host webview leaves with its disposal"
    );
    assert_eq!(
        hosts.take("plain"),
        None,
        "a plugin without a host webview takes nothing"
    );
}

// contract: plugin-host.reload-disposes
#[test]
fn a_page_start_disposes_every_host_webview_and_the_next_readiness_creates_them_again() {
    let hosts = PluginHosts::default();
    hosts.insert("probe", 1);
    hosts.insert("other", 2);
    let handles = hosts.take_all();
    assert_eq!(
        handles.len(),
        2,
        "the page start takes every host webview of the window"
    );
    assert!(
        !handles.contains(&0),
        "every taken record names the host webview that the host closes"
    );
    let plugins = vec![HostPlugin {
        id: "probe".into(),
        page: "ui/host.html".into(),
        state: None,
    }];
    assert_eq!(
        hosts.missing(&plugins, &PluginHostRestarts::default()),
        plugins,
        "the next readiness creates the host webviews again"
    );
}

// contract: plugin-host.close-disposes
#[test]
fn the_window_close_disposes_every_host_webview() {
    let hosts = PluginHosts::default();
    hosts.insert("probe", 1);
    assert_eq!(
        hosts.take_all().len(),
        1,
        "the close takes every host webview of the window"
    );
    assert!(
        hosts.take_all().is_empty(),
        "a window whose hosts are disposed takes nothing"
    );
}

// contract: plugin-host.declaration-requires-page
#[test]
fn a_host_declaration_without_a_page_is_an_error() {
    static LOCK: Mutex<()> = Mutex::new(());
    let _guard = LOCK.lock().unwrap();
    let page = |manifest: Value| plugin_host::host_declaration("probe", &manifest);
    assert_eq!(
        page(json!({"host": "ui/host.html"})),
        Err("plugin probe declares host that is not an object".to_string()),
        "a host that is not an object is refused"
    );
    assert_eq!(
        page(json!({"host": {}})),
        Err("plugin probe declares host without a page".to_string()),
        "a host without a page is refused"
    );
    assert_eq!(
        page(json!({"host": {"page": 5}})),
        Err("plugin probe declares host without a page".to_string()),
        "a host whose page is not a string is refused"
    );
    assert_eq!(
        page(json!({"host": {"page": "ui/host.html"}})),
        Ok(Some(("ui/host.html".to_string(), None))),
        "the page of the host declaration is the page of the host webview"
    );
    assert_eq!(
        page(json!({"id": "probe"})),
        Ok(None),
        "a manifest without host declares no host"
    );
}

// contract: plugin-host.state.declaration
#[test]
fn a_host_state_declaration_needs_format_and_max_bytes() {
    assert_eq!(
        plugin_host::host_declaration(
            "probe",
            &json!({"host": {"page": "ui/host.html", "state": {"format": 2, "maxBytes": 65536}}})
        ),
        Ok(Some((
            "ui/host.html".to_string(),
            Some(HostState {
                format: 2,
                max_bytes: 65536
            })
        )))
    );
    for state in [
        json!(null),
        json!(1),
        json!({}),
        json!({"format": 1}),
        json!({"maxBytes": 1}),
        json!({"format": 0, "maxBytes": 1}),
        json!({"format": 1, "maxBytes": -1}),
        json!({"format": 1.5, "maxBytes": 1}),
        json!({"format": "1", "maxBytes": 1}),
        json!({"format": 1, "maxBytes": 1, "other": 1}),
    ] {
        assert_eq!(
            plugin_host::host_declaration(
                "probe",
                &json!({"host": {"page": "ui/host.html", "state": state.clone()}})
            ),
            Err(
                "plugin probe declares host state that is not {format, maxBytes} with positive integers"
                    .to_string()
            ),
            "the state {state} is accepted"
        );
    }
}

/// Returns restart-limit records whose clock is the start plus the offset that the check sets, and that offset.
fn moved_restarts() -> (PluginHostRestarts, Arc<Mutex<Duration>>) {
    let start = Instant::now();
    let offset = Arc::new(Mutex::new(Duration::ZERO));
    let clock = offset.clone();
    let restarts = PluginHostRestarts::default().with_clock(move || start + *clock.lock().unwrap());
    (restarts, offset)
}

/// Counts a failure of the host of probe at the offset of seconds.
fn fail_at(restarts: &PluginHostRestarts, offset: &Mutex<Duration>, seconds: u64) -> Failure {
    *offset.lock().unwrap() = Duration::from_secs(seconds);
    restarts.failed("probe")
}

/// The host plugin probe of the checks.
fn probe() -> Vec<HostPlugin> {
    vec![HostPlugin {
        id: "probe".into(),
        page: "ui/host.html".into(),
        state: None,
    }]
}

// contract: plugin-host.restart.failure-restarts
#[test]
fn a_failure_of_a_plugin_host_creates_it_again_with_the_attempt_since_the_reset() {
    let (restarts, offset) = moved_restarts();
    assert_eq!(fail_at(&restarts, &offset, 0), Failure::Restart(1));
    assert_eq!(fail_at(&restarts, &offset, 10), Failure::Restart(2));
    // A failure more than 300 seconds before the new one is not counted.
    assert_eq!(fail_at(&restarts, &offset, 400), Failure::Restart(3));
    assert_eq!(fail_at(&restarts, &offset, 500), Failure::Restart(4));
    assert!(!restarts.stopped("probe"), "the host of probe is stopped");
    assert_eq!(
        PluginHosts::default().missing(&probe(), &restarts),
        probe(),
        "a running host is not created again"
    );
}

// contract: plugin-host.restart.fourth-failure-stops
#[test]
fn the_fourth_failure_within_300_seconds_stops_the_plugin_host() {
    let (restarts, offset) = moved_restarts();
    for seconds in [0, 10, 20] {
        assert!(matches!(
            fail_at(&restarts, &offset, seconds),
            Failure::Restart(_)
        ));
    }
    assert_eq!(fail_at(&restarts, &offset, 30), Failure::Stop);
    assert!(
        restarts.stopped("probe"),
        "the restarts of probe are not stopped"
    );
    assert_eq!(
        fail_at(&restarts, &offset, 40),
        Failure::Stopped,
        "a failure after the stop is counted"
    );
    assert!(
        PluginHosts::default()
            .missing(&probe(), &restarts)
            .is_empty(),
        "a page readiness creates the host of a stopped plugin"
    );
    assert!(
        !restarts.stopped("plain"),
        "the stop of probe stopped plain"
    );
}

// contract: plugin-host.restart.surface-open-resets
#[test]
fn the_open_of_a_surface_of_the_plugin_clears_the_stop() {
    let (restarts, offset) = moved_restarts();
    assert_eq!(fail_at(&restarts, &offset, 0), Failure::Restart(1));
    assert!(
        !restarts.reset("probe"),
        "the open of a surface of a running host cleared its record"
    );
    for seconds in [10, 20] {
        fail_at(&restarts, &offset, seconds);
    }
    assert_eq!(fail_at(&restarts, &offset, 30), Failure::Stop);
    assert!(
        !restarts.reset("plain"),
        "the open of a surface of another plugin cleared a record"
    );
    assert!(restarts.stopped("probe"));
    assert!(
        restarts.reset("probe"),
        "the open of a surface of probe kept its stop"
    );
    assert_eq!(
        PluginHosts::default().missing(&probe(), &restarts),
        probe(),
        "the reset does not create the host again"
    );
    assert_eq!(
        fail_at(&restarts, &offset, 40),
        Failure::Restart(1),
        "the reset kept the failures or the attempts"
    );
}

// contract: plugin-host.restart.enable-clears-stops
#[test]
fn the_enable_of_the_plugin_clears_the_stop_and_reloads_every_window_once() {
    let (restarts, offset) = moved_restarts();
    let labels = vec!["main".to_string(), "aux".to_string()];
    assert_eq!(fail_at(&restarts, &offset, 0), Failure::Restart(1));
    let mut reloaded = Vec::new();
    assert!(
        !clear_enabled_stop(&restarts, "probe", &labels, |label| reloaded
            .push(label.to_string())),
        "the enable of a running host cleared a stop"
    );
    assert!(
        reloaded.is_empty(),
        "the enable of a plugin with no stop reloaded {reloaded:?}"
    );
    for seconds in [10, 20, 30] {
        fail_at(&restarts, &offset, seconds);
    }
    assert!(restarts.stopped("probe"), "probe is not stopped");
    let mut reloaded = Vec::new();
    assert!(
        clear_enabled_stop(&restarts, "probe", &labels, |label| reloaded
            .push(label.to_string())),
        "the enable of a stopped plugin cleared no stop"
    );
    assert_eq!(reloaded, labels, "the enable reloaded the wrong windows");
    assert!(!restarts.stopped("probe"), "the enable left probe stopped");
    assert_eq!(
        fail_at(&restarts, &offset, 40),
        Failure::Restart(1),
        "the enable kept the failures or the attempts"
    );
}
