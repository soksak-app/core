use super::*;

// contract: recording.finish.layout-trace-failure-preserves-folder
#[test]
fn a_layout_trace_failure_keeps_the_started_capture_folder() {
    let parent = tempfile::tempdir().unwrap();
    let folder = parent.path().join("frames");
    std::fs::create_dir_all(&folder).unwrap();

    let result = finish_capture_stop(&folder, 1, false, || {
        Err(internal("layout trace stop failed"))
    });

    assert_eq!(result.unwrap_err().message, "layout trace stop failed");
    assert!(folder.is_dir(), "failed capture evidence was removed");
}
