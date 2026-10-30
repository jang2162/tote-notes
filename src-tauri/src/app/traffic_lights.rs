//! The macOS traffic lights on the overlaid title bar, placed in AppKit directly so their vertical
//! middle sits on the top row's (`--top-row-height`).
//!
//! Not through `WebviewWindowBuilder::traffic_light_position` (tauri 2.12): it hands the position
//! to wry alone, whose inset only makes the buttons' container `button height + y` tall and leaves
//! each button at AppKit's own offset from the container's bottom (9pt on macOS 27). The buttons'
//! top then lands at `y - offset`, an offset that differs between macOS versions. tao's copy of
//! the inset, which it puts back after `setTitle:` and after full screen, cannot be set through
//! tauri, so a new title (a workspace switch, a window renumbered) left the buttons where AppKit
//! puts them.
//!
//! AppKit lays the title bar out again after `setTitle:` and around full screen: `set_title` sets
//! the title and places the buttons after it, and `on_resized` places them once the window is out
//! of full screen. Main thread only, as AppKit wants.

use objc2_app_kit::{NSButton, NSWindow, NSWindowButton, NSWindowStyleMask};
use objc2_foundation::{MainThreadMarker, NSPoint, NSString};
use tauri::{WebviewWindow, Window};

/// The window's top row in logical pixels: the CSS `--top-row-height`.
const TOP_ROW_HEIGHT: f64 = 36.0;
/// The close button's left edge from the window's left edge. The CSS `--traffic-lights-width`
/// leaves room for this and the three buttons.
const TRAFFIC_LIGHTS_X: f64 = 14.0;

/// The buttons' container height and each button's y from the container's bottom (AppKit's
/// container is not flipped and sits at the window's top), for buttons `button_height` tall whose
/// container AppKit made `container_height` tall: the buttons' middle on the top row's. The
/// container grows when it is too short for that.
fn vertical(container_height: f64, button_height: f64) -> (f64, f64) {
    let top = (TOP_ROW_HEIGHT - button_height) / 2.0;
    let height = container_height.max(top + button_height);
    (height, height - top - button_height)
}

fn buttons(ns_window: &NSWindow) -> Option<[objc2::rc::Retained<NSButton>; 3]> {
    Some([
        ns_window.standardWindowButton(NSWindowButton::CloseButton)?,
        ns_window.standardWindowButton(NSWindowButton::MiniaturizeButton)?,
        ns_window.standardWindowButton(NSWindowButton::ZoomButton)?,
    ])
}

/// Puts the buttons in place. In full screen AppKit keeps them in a bar of its own: left alone.
fn place_now(ns_window: &NSWindow) {
    if ns_window
        .styleMask()
        .contains(NSWindowStyleMask::FullScreen)
    {
        return;
    }
    let Some(buttons) = buttons(ns_window) else {
        return;
    };
    // SAFETY: the buttons are AppKit's own, in the window's title bar view, in its container.
    let Some(container) = (unsafe { buttons[0].superview().and_then(|bar| bar.superview()) })
    else {
        return;
    };
    let close = buttons[0].frame();
    let spacing = buttons[1].frame().origin.x - close.origin.x;
    let (height, y) = vertical(container.frame().size.height, close.size.height);
    let mut frame = container.frame();
    if frame.size.height != height {
        frame.size.height = height;
        frame.origin.y = ns_window.frame().size.height - height;
        container.setFrame(frame);
    }
    for (i, button) in buttons.iter().enumerate() {
        button.setFrameOrigin(NSPoint::new(TRAFFIC_LIGHTS_X + i as f64 * spacing, y));
    }
}

fn on_main(window: &WebviewWindow, run: impl FnOnce(&NSWindow) + Send + 'static) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(ptr) = target.ns_window() {
            // SAFETY: tauri hands out the window's live `NSWindow`, and this runs on the main thread.
            run(unsafe { &*ptr.cast::<NSWindow>() });
        }
    });
}

/// Puts the buttons of a window just made in place.
pub fn place(window: &WebviewWindow) {
    on_main(window, place_now);
}

/// Titles the window and puts the buttons back where the new title's layout took them from.
/// tauri's `set_title` sets the title later on the main queue, after a placement made here.
pub fn set_title(window: &WebviewWindow, title: &str) {
    let title = title.to_string();
    on_main(window, move |ns_window| {
        ns_window.setTitle(&NSString::from_str(&title));
        place_now(ns_window);
    });
}

/// A window resized, as it is when it leaves full screen, where AppKit put the buttons back.
/// Window events come on the main thread.
pub fn on_resized(window: &Window) {
    if MainThreadMarker::new().is_none() {
        return;
    }
    if let Ok(ptr) = window.ns_window() {
        // SAFETY: as in `on_main`.
        place_now(unsafe { &*ptr.cast::<NSWindow>() });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The buttons' middle, from the window's top.
    fn middle(container_height: f64, button_height: f64) -> f64 {
        let (height, y) = vertical(container_height, button_height);
        height - y - button_height / 2.0
    }

    #[test]
    fn the_buttons_middle_is_the_top_rows() {
        // macOS 27: a 32pt container, 14pt buttons.
        assert_eq!(vertical(32.0, 14.0), (32.0, 7.0));
        for (container, button) in [(32.0, 14.0), (28.0, 14.0), (28.0, 16.0), (40.0, 14.0)] {
            assert_eq!(middle(container, button), TOP_ROW_HEIGHT / 2.0);
        }
    }

    #[test]
    fn a_container_too_short_grows_to_hold_them() {
        assert_eq!(vertical(20.0, 14.0), (25.0, 0.0));
        assert_eq!(middle(20.0, 14.0), TOP_ROW_HEIGHT / 2.0);
    }
}
