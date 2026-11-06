use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Mutex;

use super::*;

const LEFT_DOWN: u16 = 0x0001;
const LEFT_UP: u16 = 0x0002;
const RIGHT_DOWN: u16 = 0x0004;
const RIGHT_UP: u16 = 0x0008;
const WHEEL: u16 = 0x0400;
const WINDOW: Handle = 7;

#[derive(Default)]
struct FakeMouse {
    swap: bool,
    window: Handle,
    views: Vec<Handle>,
    at: Cell<(f64, f64)>,
    fails: Cell<bool>,
    hit_fails: bool,
    hits: Cell<u32>,
}

impl MouseSystem for &FakeMouse {
    fn swapped(&self) -> bool {
        self.swap
    }
    fn hit(&self) -> Result<Option<(Handle, Vec<Handle>)>, String> {
        self.hits.set(self.hits.get() + 1);
        if self.hit_fails {
            return Err("no position".into());
        }
        if self.window == 0 {
            return Ok(None);
        }
        Ok(Some((self.window, self.views.clone())))
    }
    fn position(&self, _window: Handle) -> Result<(f64, f64), String> {
        if self.fails.get() {
            return Err("the window is gone".into());
        }
        Ok(self.at.get())
    }
}

fn surface_mouse(views: &[Handle]) -> FakeMouse {
    FakeMouse {
        window: WINDOW,
        views: views.to_vec(),
        ..FakeMouse::default()
    }
}

type Points = Rc<RefCell<Vec<(u8, f64, f64)>>>;

/// A watch whose pressed answers whether surface is one of the views, and the steps that it received.
fn input_watch(surface: Handle, dragging: Arc<AtomicBool>) -> (InputWatch, Points) {
    let points: Points = Rc::default();
    let received = points.clone();
    (
        InputWatch {
            pressed: Box::new(move |views| views.contains(&surface)),
            pointed: Box::new(move |phase, x, y| received.borrow_mut().push((phase, x, y))),
            dragging,
        },
        points,
    )
}

fn run_steps(watch: &InputWatch, steps: Vec<MouseStep>) {
    for step in steps {
        match step {
            MouseStep::Press { views, x, y, .. } => watch.press(views, x, y),
            MouseStep::Move { x, y, .. } => watch.moved(x, y),
            MouseStep::Release { x, y, .. } => watch.release(x, y),
            MouseStep::Buttons(_) => {}
        }
    }
}

// contract: platform.windows.mouse.mask-follows-raw-input-buttons
#[test]
fn the_mask_follows_every_button_of_a_raw_input() {
    for (flags, from, want, named) in [
        (0x0001, 0, 1 << 0, true),
        (0x0002, 1 << 0, 0, true),
        (0x0004, 0, 1 << 1, true),
        (0x0008, 1 << 1, 0, true),
        (0x0010, 0, 1 << 2, true),
        (0x0020, 1 << 2, 0, true),
        (0x0040, 0, 1 << 3, true),
        (0x0080, 1 << 3, 0, true),
        (0x0100, 0, 1 << 4, true),
        (0x0200, 1 << 4, 0, true),
        (0x0003, 0, 0, true),
        (WHEEL, 1 << 1, 1 << 1, false),
        (0, 1 << 1, 1 << 1, false),
    ] {
        assert_eq!(next_buttons(from, flags), (want, named), "flags {flags:#x}");
    }
}

// contract: platform.windows.mouse.held-buttons-name-their-bits
#[test]
fn the_held_buttons_name_their_bits() {
    assert_eq!(
        buttons_held(|key| key == 0x02 || key == 0x06),
        1 << 1 | 1 << 4
    );
}

// contract: platform.windows.mouse.button-watch-reports-mask-from-its-start
#[test]
fn every_button_input_reports_its_mask_once_reports_started() {
    let watches = Mutex::new(MouseWatches::new());
    set_mask(&watches, 1 << 1);
    let system = FakeMouse::default();
    let mut reader = MouseReader::new(&system, &watches);
    assert_eq!(reader.receive(LEFT_DOWN).0, vec![]);
    assert_eq!(start_reports(&watches), Ok(1 << 1 | 1 << 0));
    let reported = |flags, reader: &mut MouseReader<&FakeMouse>| reader.receive(flags).0;
    assert_eq!(
        reported(RIGHT_DOWN, &mut reader),
        vec![MouseStep::Buttons(3)]
    );
    assert_eq!(reported(0, &mut reader), vec![]);
    assert_eq!(reported(WHEEL, &mut reader), vec![]);
    assert_eq!(reported(LEFT_UP, &mut reader), vec![MouseStep::Buttons(2)]);
    assert_eq!(reported(RIGHT_UP, &mut reader), vec![MouseStep::Buttons(0)]);
}

// contract: platform.windows.mouse.second-button-watch-is-refused
#[test]
fn a_second_button_watch_is_refused() {
    let watches = Mutex::new(MouseWatches::new());
    assert!(start_reports(&watches).is_ok());
    assert!(start_reports(&watches).is_err());
}

// contract: platform.windows.mouse.drag-over-surface-reaches-window-in-order
#[test]
fn a_drag_that_starts_over_a_surface_reaches_its_window_in_order() {
    let watches = Mutex::new(MouseWatches::new());
    let (monitor, dragging) = add_watch(&watches, WINDOW);
    let (watch, points) = input_watch(20, dragging);
    let system = surface_mouse(&[30, 20, 10]);
    system.at.set((1.0, 2.0));
    let mut reader = MouseReader::new(&system, &watches);
    let (steps, _) = reader.receive(LEFT_DOWN);
    assert_eq!(
        steps,
        vec![MouseStep::Press {
            monitor,
            views: vec![30, 20, 10],
            x: 1.0,
            y: 2.0
        }]
    );
    run_steps(&watch, steps);
    system.at.set((3.0, 4.0));
    run_steps(&watch, reader.receive(0).0);
    system.at.set((5.0, 6.0));
    run_steps(&watch, reader.receive(LEFT_UP).0);
    assert_eq!(
        *points.borrow(),
        vec![(0, 1.0, 2.0), (1, 3.0, 4.0), (2, 5.0, 6.0)]
    );
    system.at.set((9.0, 6.0));
    assert_eq!(reader.receive(0).0, vec![]);
}

// contract: platform.windows.mouse.fast-click-still-ends-its-drag
#[test]
fn a_click_faster_than_the_ui_thread_still_ends_its_drag() {
    let watches = Mutex::new(MouseWatches::new());
    let (_, dragging) = add_watch(&watches, WINDOW);
    let (watch, points) = input_watch(20, dragging);
    let system = surface_mouse(&[20]);
    let mut reader = MouseReader::new(&system, &watches);
    let mut queued = reader.receive(LEFT_DOWN).0;
    queued.extend(reader.receive(LEFT_UP).0);
    run_steps(&watch, queued);
    assert_eq!(*points.borrow(), vec![(0, 0.0, 0.0), (2, 0.0, 0.0)]);
}

// contract: platform.windows.mouse.page-drag-never-wakes-ui-thread
#[test]
fn a_drag_of_the_page_never_wakes_the_ui_thread() {
    let watches = Mutex::new(MouseWatches::new());
    let (_, dragging) = add_watch(&watches, WINDOW);
    let (watch, points) = input_watch(20, dragging);
    let system = surface_mouse(&[30]);
    let mut reader = MouseReader::new(&system, &watches);
    run_steps(&watch, reader.receive(LEFT_DOWN).0);
    system.at.set((1.0, 0.0));
    assert_eq!(reader.receive(0).0, vec![]);
    run_steps(&watch, reader.receive(LEFT_UP).0);
    assert!(points.borrow().is_empty());
}

// contract: platform.windows.mouse.move-without-position-change-wakes-nothing
#[test]
fn a_move_without_a_position_change_wakes_nothing() {
    let watches = Mutex::new(MouseWatches::new());
    let (_, dragging) = add_watch(&watches, WINDOW);
    let (watch, _) = input_watch(20, dragging);
    let system = surface_mouse(&[20]);
    system.at.set((1.0, 0.0));
    let mut reader = MouseReader::new(&system, &watches);
    run_steps(&watch, reader.receive(LEFT_DOWN).0);
    assert_eq!(reader.receive(0).0, vec![]);
    assert_eq!(reader.receive(WHEEL).0, vec![]);
}

// contract: platform.windows.mouse.press-over-another-window-is-not-delivered
#[test]
fn a_press_over_another_window_is_not_delivered() {
    for window in [8, 0] {
        let watches = Mutex::new(MouseWatches::new());
        add_watch(&watches, WINDOW);
        let system = FakeMouse {
            window,
            views: vec![20],
            ..FakeMouse::default()
        };
        let mut reader = MouseReader::new(&system, &watches);
        assert_eq!(reader.receive(LEFT_DOWN).0, vec![], "window {window}");
        assert_eq!(reader.receive(LEFT_UP).0, vec![], "window {window}");
    }
}

// contract: platform.windows.mouse.primary-button-follows-system-exchange
#[test]
fn the_primary_button_follows_the_system_exchange() {
    let watches = Mutex::new(MouseWatches::new());
    let (_, dragging) = add_watch(&watches, WINDOW);
    let (watch, points) = input_watch(20, dragging);
    let system = FakeMouse {
        swap: true,
        ..surface_mouse(&[20])
    };
    let mut reader = MouseReader::new(&system, &watches);
    run_steps(&watch, reader.receive(LEFT_DOWN).0);
    run_steps(&watch, reader.receive(LEFT_UP).0);
    assert_eq!(system.hits.get(), 0);
    run_steps(&watch, reader.receive(RIGHT_DOWN).0);
    run_steps(&watch, reader.receive(RIGHT_UP).0);
    assert_eq!(system.hits.get(), 1);
    assert_eq!(*points.borrow(), vec![(0, 0.0, 0.0), (2, 0.0, 0.0)]);
}

// contract: platform.windows.mouse.secondary-button-is-no-drag
#[test]
fn a_secondary_button_is_no_drag() {
    let watches = Mutex::new(MouseWatches::new());
    add_watch(&watches, WINDOW);
    let system = surface_mouse(&[20]);
    let mut reader = MouseReader::new(&system, &watches);
    assert_eq!(reader.receive(RIGHT_DOWN).0, vec![]);
    assert_eq!(system.hits.get(), 0);
}

// contract: platform.windows.mouse.removed-watch-takes-no-input
#[test]
fn a_removed_watch_is_not_read() {
    let watches = Mutex::new(MouseWatches::new());
    let (monitor, _) = add_watch(&watches, WINDOW);
    remove_watch(&watches, monitor);
    let system = surface_mouse(&[20]);
    let mut reader = MouseReader::new(&system, &watches);
    assert_eq!(reader.receive(LEFT_DOWN).0, vec![]);
}

// contract: platform.windows.mouse.read-failure-is-reported-and-release-ends-drag
#[test]
fn a_read_failure_is_reported_and_a_release_still_ends_the_drag() {
    let watches = Mutex::new(MouseWatches::new());
    let (_, dragging) = add_watch(&watches, WINDOW);
    let (watch, points) = input_watch(20, dragging);
    let system = surface_mouse(&[20]);
    system.at.set((1.0, 2.0));
    let mut reader = MouseReader::new(&system, &watches);
    run_steps(&watch, reader.receive(LEFT_DOWN).0);
    system.fails.set(true);
    let (moved, moved_failures) = reader.receive(0);
    assert_eq!((moved, moved_failures.len()), (vec![], 1));
    let (released, release_failures) = reader.receive(LEFT_UP);
    assert_eq!(release_failures.len(), 1);
    run_steps(&watch, released);
    assert_eq!(*points.borrow(), vec![(0, 1.0, 2.0), (2, 1.0, 2.0)]);
}

// contract: platform.windows.mouse.unreadable-hit-is-reported
#[test]
fn a_hit_that_cannot_be_read_is_reported() {
    let watches = Mutex::new(MouseWatches::new());
    let (_, dragging) = add_watch(&watches, WINDOW);
    let (watch, points) = input_watch(20, dragging);
    let system = FakeMouse {
        hit_fails: true,
        ..surface_mouse(&[20])
    };
    let mut reader = MouseReader::new(&system, &watches);
    let (steps, failures) = reader.receive(LEFT_DOWN);
    assert_eq!(failures.len(), 1);
    assert_eq!(steps, vec![]);
    run_steps(&watch, steps);
    run_steps(&watch, reader.receive(LEFT_UP).0);
    assert!(points.borrow().is_empty());
}
