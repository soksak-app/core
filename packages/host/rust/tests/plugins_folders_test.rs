//! Checks the count of the plugin folders that the host watches (docs/spec/installation.md#plugin-operations-in-the-application).

use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

use soksak_host::plugins::Plugins;

/// Waits for the next count of the watch and fails when it is not `want` within 10 seconds.
fn expect_count(counts: &mpsc::Receiver<usize>, want: usize) {
    let got = counts
        .recv_timeout(Duration::from_secs(10))
        .unwrap_or_else(|_| panic!("no folder count {want} within 10 s"));
    assert_eq!(got, want, "folder count");
}

// contract: plugins.folders.count-follows-a-folder-added-or-removed
#[test]
fn plugin_folder_count_follows_a_folder_added_or_removed() {
    let config = tempfile::tempdir().expect("config");
    std::fs::create_dir_all(config.path().join("plugins")).expect("plugins folder");
    let plugins = Plugins::new(
        config.path().to_path_buf(),
        Box::new(|| None),
        Box::new(|| Ok(())),
        Box::new(|_| {}),
    )
    .expect("plugins");
    let (sender, counts) = mpsc::channel();
    let stop = plugins
        .watch_folders(Arc::new(move |count| {
            let _ = sender.send(count);
        }))
        .expect("watch");
    let folder = config.path().join("plugins").join("probe");
    std::fs::create_dir(&folder).expect("add folder");
    expect_count(&counts, 1);
    std::fs::remove_dir(&folder).expect("remove folder");
    expect_count(&counts, 0);
    stop();
}
