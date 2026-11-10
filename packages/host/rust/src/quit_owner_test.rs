use super::*;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;

/// A quit that the system requests during the native work of an endpoint request runs after the response of that request,
/// and once; outside such work, or for a request without a response, it runs at once.
// contract: endpoint.response.quit-follows-the-response
#[test]
fn quit_during_owned_native_work_follows_the_response() {
    let (scope, mut completion) = ReplyScope::pending_on(crate::endpoint::ConnectionEnd::open());
    let quits = Arc::new(AtomicUsize::new(0));
    let count = || quits.load(Ordering::SeqCst);
    let quit = {
        let quits = quits.clone();
        move || {
            quits.fetch_add(1, Ordering::SeqCst);
        }
    };
    let result: Result<(), &str> = with_response_owner(Some(&scope), || {
        after_owner_response(quit.clone());
        assert_eq!(
            count(),
            0,
            "the quit ran inside the native work, before the response"
        );
        Err("the item failed")
    });
    assert_eq!(
        result,
        Err("the item failed"),
        "the native work did not return its own error"
    );
    assert_eq!(
        count(),
        0,
        "the quit ran after the native work, before the response"
    );
    assert!(completion.finish(ReplyOutcome::Written));
    assert!(!completion.finish(ReplyOutcome::Written));
    assert_eq!(count(), 1, "the quit did not run once after the response");

    after_owner_response(quit.clone());
    assert_eq!(
        count(),
        2,
        "a quit without owned native work did not run at once"
    );
    with_response_owner(None, || after_owner_response(quit.clone()));
    assert_eq!(
        count(),
        3,
        "a quit in the native work of a request without a response did not run at once"
    );
}
