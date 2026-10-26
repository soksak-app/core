use super::*;

// contract: performance.sampler.reads-plugin-host-process
#[test]
fn plugin_host_facts_match_registered_handles_only() {
    let webviews = vec![
        json!({"view": 11, "process": 101, "main": true}),
        json!({"view": 22, "process": 202, "document": true}),
        json!({"view": 33, "process": 303}),
    ];
    let registered = vec![("files".to_string(), 33)];
    assert_eq!(
        plugin_host_processes_for_facts(&webviews, &registered).unwrap(),
        vec![crate::performance::PluginHostProcess {
            plugin: "files".into(),
            process: 303,
        }],
        "unregistered page and document views are excluded"
    );
}

#[test]
fn plugin_host_facts_preserve_unstarted_and_reject_missing_handles() {
    let webviews = vec![json!({"view": 33, "process": 0})];
    let registered = vec![("files".to_string(), 33)];
    let processes = plugin_host_processes_for_facts(&webviews, &registered).unwrap();
    assert_eq!(processes.len(), 1);
    assert_eq!(processes[0].plugin, "files");
    assert_eq!(processes[0].process, 0);
    assert_eq!(
        plugin_host_processes_for_facts(&[], &registered).unwrap_err(),
        "plugin host files is absent from window facts"
    );
}
