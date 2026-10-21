//! The view join of the presentation wait (docs/spec/plugin-processes.md, rule 6): the shown view that waits for nothing joins the
//! open layout transaction, and a view that waits does not join again. The same cases run in the Go host.

use super::views_to_join;

// contract: view.presentation-wait.joins
#[test]
fn a_shown_view_that_waits_for_nothing_joins_the_open_transaction() {
    let joined = views_to_join(
        ["probe-surface", "app-surface", "waiting-surface"],
        |surface| surface == "probe-surface" || surface == "waiting-surface",
        |surface| surface == "waiting-surface",
    );
    assert_eq!(
        joined,
        vec!["probe-surface"],
        "only the view that waits for nothing joins, and a surface that is not a view does not"
    );
}
