//! 닫히는 창의 논리 표면과 그 문서 영역, 그림 영역을 닫는 순서와 실패 보고를 검사한다.

use std::collections::HashMap;

use soksak_host_tauriv2::documents::Documents;
use soksak_host_tauriv2::images::Images;
use soksak_host_tauriv2::surfaces::{close_window_surfaces, WindowNative};

fn key(surface: &str, name: &str) -> (String, String) {
    (surface.to_string(), name.to_string())
}

// contract: window-close.surfaces.closes-regions-then-surface
#[test]
fn closing_a_window_closes_each_surface_after_its_regions() {
    let documents = Documents::default();
    let images = Images::default();
    for (k, handle) in [(key("tab-1", "page"), 11), (key("tab-2", "page"), 21)] {
        documents.reserve(&k).unwrap();
        assert!(documents.set(&k, handle));
    }
    // 만드는 중인 문서 영역은 닫을 핸들이 없다.
    documents.reserve(&key("tab-2", "pending")).unwrap();
    images
        .reserve(&key("tab-1", "view"), "owner", "sidecar")
        .unwrap();
    assert!(images.set(&key("tab-1", "view"), 12));
    let surfaces = HashMap::from([("tab-2".to_string(), 200), ("tab-1".to_string(), 100)]);
    let mut closed = Vec::new();
    close_window_surfaces(surfaces, &documents, &images, &mut |native| {
        closed.push(native);
        Ok(())
    })
    .unwrap();
    assert_eq!(
        closed,
        vec![
            WindowNative::Document(11),
            WindowNative::Image(12),
            WindowNative::Surface(100),
            WindowNative::Document(21),
            WindowNative::Surface(200),
        ]
    );
    assert!(
        documents.names().is_empty(),
        "the closed surfaces keep document names"
    );
    assert!(
        documents.reserve(&key("tab-2", "pending")).is_ok(),
        "the closed surface keeps its pending document name"
    );
    assert!(
        images.remove_surface("tab-1").is_empty(),
        "the closed surface keeps its images"
    );
}

// contract: window-close.surfaces.reports-every-failure
#[test]
fn closing_a_window_reports_every_failure_and_closes_the_rest() {
    let documents = Documents::default();
    let images = Images::default();
    documents.reserve(&key("tab-1", "page")).unwrap();
    assert!(documents.set(&key("tab-1", "page"), 11));
    let surfaces = HashMap::from([("tab-1".to_string(), 100), ("tab-2".to_string(), 200)]);
    let mut closed = Vec::new();
    let result = close_window_surfaces(surfaces, &documents, &images, &mut |native| {
        closed.push(native);
        match native {
            WindowNative::Document(_) => Err("document failed".into()),
            WindowNative::Surface(200) => Err("surface failed".into()),
            _ => Ok(()),
        }
    });
    assert_eq!(
        closed,
        vec![
            WindowNative::Document(11),
            WindowNative::Surface(100),
            WindowNative::Surface(200),
        ]
    );
    let error = result.unwrap_err();
    assert!(
        error.contains("document failed") && error.contains("surface failed"),
        "{error}"
    );
}
