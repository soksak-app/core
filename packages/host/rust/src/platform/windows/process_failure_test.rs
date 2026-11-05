use super::*;

#[test]
fn the_end_of_the_page_process_ends_the_page() {
    assert_eq!(process_failure(0), ProcessFailure::PageEnded);
    assert_eq!(process_failure(1), ProcessFailure::PageEnded);
}

#[test]
fn every_other_kind_keeps_the_page() {
    for kind in 2..=9 {
        assert_eq!(process_failure(kind), ProcessFailure::PageStays, "{kind}");
    }
}
