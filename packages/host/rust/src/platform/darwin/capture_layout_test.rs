use super::*;

// contract: diagnostics.layout-trace.native-record-names-its-commit
// The native record of a layout transaction holds ticket, begun, presented, committed, requested, the commit path code, the
// number of other CATransaction pairs open at the commit, the time its outermost transaction was sent to the render server, the
// display refresh that carried it and the refresh before the callback that read it. Each code becomes the name of its path, and
// a transaction that did not commit keeps no path.
#[test]
fn a_native_layout_record_names_its_commit_path() {
    let nan = f64::NAN;
    let rows = [
        [
            7.0,
            10.0,
            20.0,
            30.0,
            15.0,
            SURFACE_LAYOUT_COMMIT_VIEW_JOIN,
            1.0,
            35.0,
            41.6,
            33.3,
        ],
        [
            8.0,
            40.0,
            50.0,
            60.0,
            45.0,
            SURFACE_LAYOUT_COMMIT_PRESENT,
            0.0,
            60.0,
            66.6,
            58.3,
        ],
        [
            9.0,
            70.0,
            80.0,
            90.0,
            nan,
            SURFACE_LAYOUT_COMMIT_START,
            0.0,
            90.0,
            100.0,
            91.6,
        ],
        [
            10.0,
            100.0,
            nan,
            110.0,
            nan,
            SURFACE_LAYOUT_COMMIT_VIEW_ABANDON,
            2.0,
            112.0,
            116.6,
            108.3,
        ],
        [
            11.0,
            120.0,
            nan,
            130.0,
            nan,
            SURFACE_LAYOUT_COMMIT_CANCEL,
            0.0,
            130.0,
            133.3,
            125.0,
        ],
        [12.0, 140.0, nan, nan, nan, nan, nan, nan, nan, nan],
        [
            13.0,
            150.0,
            nan,
            160.0,
            nan,
            SURFACE_LAYOUT_COMMIT_INPUT,
            0.0,
            160.0,
            166.6,
            158.3,
        ],
    ];
    let records = layout_records(&rows.concat(), 7).unwrap();
    let paths: Vec<_> = records.iter().map(|record| record.commit_path).collect();
    assert_eq!(
        paths,
        [
            Some("view-join"),
            Some("present"),
            Some("start"),
            Some("view-abandon"),
            Some("cancel"),
            None,
            Some("input")
        ]
    );
    assert_eq!(
        records[0],
        LayoutRecord {
            ticket: 7,
            begun: 10.0,
            requested: 15.0,
            presented: 20.0,
            committed: 30.0,
            commit_path: Some("view-join"),
            open_at_commit: 1.0,
            flushed: 35.0,
            displayed: 41.6,
            refreshed: 33.3,
        }
    );
    let last = records[5];
    assert!(
        last.ticket == 12
            && last.committed.is_nan()
            && last.open_at_commit.is_nan()
            && last.flushed.is_nan()
            && last.displayed.is_nan()
            && last.refreshed.is_nan()
    );
}

// contract: diagnostics.layout-trace.unknown-commit-path-fails
// A commit path code that the native code does not declare is an error, not a record without a path.
#[test]
fn a_native_layout_record_with_an_unknown_commit_path_fails() {
    assert!(
        layout_records(
            &[7.0, 10.0, 20.0, 30.0, 15.0, 99.0, 0.0, 30.0, 33.3, 25.0],
            1
        )
        .is_err()
    );
}
