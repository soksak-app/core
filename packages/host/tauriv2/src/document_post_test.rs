// contract: view.channel.ui-thread
#[test]
fn a_native_view_post_is_a_main_thread_task() {
    let dispatched = std::cell::Cell::new(0);
    let result = crate::documents::post_document_via(
        |task| {
            dispatched.set(dispatched.get() + 1);
            drop(task);
            Ok(true)
        },
        0,
        "{\"event\":\"theme\"}".to_string(),
    );
    assert_eq!(result, Ok(true));
    assert_eq!(
        dispatched.get(),
        1,
        "the native view post runs on the main thread through the dispatch"
    );
}
