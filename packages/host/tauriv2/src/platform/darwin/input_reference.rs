//! Diagnostic input reference calls of the shared native library.

use super::super::Handle;
use serde_json::Value;
use std::ffi::{CStr, CString, c_char, c_void};

type Completion = Box<dyn Fn(Result<Value, String>)>;
unsafe extern "C" {
    fn sp_input_reference(
        window: *mut c_void,
        action: *const c_char,
        expected: *const c_char,
        done: unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char),
        context: *mut c_void,
    );
}
unsafe extern "C" fn replied(context: *mut c_void, value: *const c_char, failure: *const c_char) {
    let done = unsafe { Box::from_raw(context as *mut Completion) };
    if !failure.is_null() {
        done(Err(unsafe { CStr::from_ptr(failure) }
            .to_string_lossy()
            .into_owned()));
        return;
    }
    let result = if value.is_null() {
        Err("input reference returned no JSON".to_owned())
    } else {
        serde_json::from_slice(unsafe { CStr::from_ptr(value) }.to_bytes())
            .map_err(|error| format!("input reference returned invalid JSON: {error}"))
    };
    done(result);
}

pub fn call(window: Handle, action: &str, document: Option<&str>, done: Completion) {
    let values = CString::new(action).and_then(|action| {
        document
            .map(CString::new)
            .transpose()
            .map(|document| (action, document))
    });
    let (action, document) = match values {
        Ok(values) => values,
        Err(_) => {
            done(Err(
                "input reference action and document cannot contain NUL".into(),
            ));
            return;
        }
    };
    unsafe {
        sp_input_reference(
            window as *mut c_void,
            action.as_ptr(),
            document
                .as_ref()
                .map_or(std::ptr::null(), |value| value.as_ptr()),
            replied,
            Box::into_raw(Box::new(done)) as *mut c_void,
        )
    };
}

#[cfg(test)]
mod tests {
    use super::call;
    use std::{cell::Cell, rc::Rc};

    // contract: diagnostics.input-reference.rejects-nul
    #[test]
    fn input_reference_rejects_nul() {
        for (action, document) in [("a\0b", None), ("wait", Some("a\0b"))] {
            let count = Rc::new(Cell::new(0));
            let completed = count.clone();
            call(
                0,
                action,
                document,
                Box::new(move |result| {
                    completed.set(completed.get() + 1);
                    assert!(result.unwrap_err().contains("NUL"));
                }),
            );
            assert_eq!(count.get(), 1);
        }
    }
}
