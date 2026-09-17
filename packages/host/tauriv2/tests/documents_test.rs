//! 문서 영역 요청의 소유 표면 검사와 창의 문서 영역 목록을 검사한다.

use soksak_host_tauriv2::documents::{check, Documents, Key, Request};

fn request(surface: &str, document: &str) -> Request {
    serde_json::from_value(serde_json::json!({"surface": surface, "document": document})).unwrap()
}

fn key(surface: &str, name: &str) -> Key {
    (surface.to_string(), name.to_string())
}

#[test]
fn document_requests_belong_to_the_calling_surface() {
    assert_eq!(check(Some("tab-1"), &request("tab-1", "page")), Ok(key("tab-1", "page")));
    for caller in [None, Some("tab-2")] {
        let error = check(caller, &request("tab-1", "page")).unwrap_err();
        assert!(error.contains("not surface"), "caller {caller:?}: {error}");
    }
    for name in ["", "Page", "-page", "a/b", &"a".repeat(65)] {
        assert!(check(Some("tab-1"), &request("tab-1", name)).is_err(), "name {name:?} was accepted");
    }
}

#[test]
fn document_request_decodes_insets() {
    let request: Request = serde_json::from_str(
        r#"{"surface":"tab-1","document":"page","left":1.5,"top":2,"right":3,"bottom":4,"visible":true}"#,
    )
    .unwrap();
    assert_eq!((request.surface.as_str(), request.document.as_str()), ("tab-1", "page"));
    let insets = request.insets;
    assert_eq!((insets.left, insets.top, insets.right, insets.bottom), (1.5, 2.0, 3.0, 4.0));
    assert!(request.visible);
}

#[test]
fn documents_reserve_names_and_close_with_their_surface() {
    let docs = Documents::default();
    let (one, two, other) = (key("tab-1", "page"), key("tab-1", "side"), key("tab-2", "page"));
    for k in [&one, &two, &other] {
        docs.reserve(k).unwrap();
    }
    assert!(docs.reserve(&one).unwrap_err().contains("already attached"));
    assert!(docs.get(&one).is_err(), "a reserved name is not an attached document");
    assert!(docs.set(&one, 1) && docs.set(&two, 2) && docs.set(&other, 3));
    assert_eq!(docs.get(&one), Ok(1));
    let names = docs.names();
    assert_eq!(names.len(), 3);
    assert_eq!(names.get(&3), Some(&other));
    assert_eq!(docs.all().len(), 3);

    let mut removed = docs.remove_surface("tab-1");
    removed.sort();
    assert_eq!(removed, vec![1, 2]);
    assert!(docs.get(&one).is_err(), "a document of a removed surface remains");
    assert_eq!(docs.get(&other), Ok(3), "another surface's document was removed");
    assert!(!docs.set(&one, 1), "a document created after its surface was removed was accepted");

    docs.reserve(&two).unwrap();
    assert_eq!(docs.remove(&two), Ok(0));
    assert_eq!(docs.remove(&other), Ok(3));
    assert!(docs.remove(&other).is_err(), "a detached name was removed twice");
}
