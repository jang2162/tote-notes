//! A window being resized gets its traffic lights put back at AppKit's own place inside
//! `setFrame:` (`-[NSThemeFrame _updateButtonPositions]`), and the frame is drawn before tao hands
//! out `Resized`. So the buttons have to be back in place when `setFrame:` returns, or they shake
//! while a window edge is dragged (src/app/traffic_lights.rs). Its own `main`, as
//! tests/menu_key_equivalents.rs and for the same reason.

#[cfg(target_os = "macos")]
fn main() {
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSApplication, NSBackingStoreType, NSWindow, NSWindowButton, NSWindowStyleMask,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use tote_lib::app::traffic_lights::follow;

    let mtm = MainThreadMarker::new().expect("a test without the harness runs on the main thread");
    let _app = NSApplication::sharedApplication(mtm);
    let style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable
        | NSWindowStyleMask::Resizable
        | NSWindowStyleMask::FullSizeContentView;
    // SAFETY: a window made and used on the main thread; released only by `window` going.
    let window = unsafe {
        let window = NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(800.0, 600.0)),
            style,
            NSBackingStoreType::Buffered,
            false,
        );
        window.setReleasedWhenClosed(false);
        window
    };
    window.setTitlebarAppearsTransparent(true);

    // The close button's x and its middle from the window's top.
    let close = || {
        let button = window
            .standardWindowButton(NSWindowButton::CloseButton)
            .unwrap();
        // SAFETY: AppKit's own button, in the title bar view, in its container.
        let container = unsafe { button.superview().unwrap().superview().unwrap() };
        let frame = button.frame();
        (
            frame.origin.x,
            container.frame().size.height - frame.origin.y - frame.size.height / 2.0,
        )
    };

    follow(&window);
    assert_eq!(close(), (14.0, 18.0));
    for size in [NSSize::new(700.0, 600.0), NSSize::new(700.0, 500.0)] {
        window.setFrame_display(NSRect::new(NSPoint::new(100.0, 100.0), size), true);
        assert_eq!(
            close(),
            (14.0, 18.0),
            "the buttons are not back in place when setFrame: returns ({}x{})",
            size.width,
            size.height
        );
    }
    window.close();
    println!("traffic_lights_resize: ok");
}

#[cfg(not(target_os = "macos"))]
fn main() {}
