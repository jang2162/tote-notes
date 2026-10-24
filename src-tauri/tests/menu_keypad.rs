//! A macOS menu does not tell a keypad key from the main-row key of the same character: muda puts
//! `NSEventModifierFlagNumericPad` in the item's mask, and AppKit leaves it out when it matches a
//! key press (settings smoke B-8). So the settings screen records such a keypad key as its
//! main-row twin, and refuses ＋ and × (`KEYPAD_TWINS`, src/shortcuts/keys.ts; `recordable`,
//! src/shortcuts.rs). When AppKit starts telling them apart this fails, and keypad keys can be
//! recorded as themselves again. Its own `main`, as tests/menu_key_equivalents.rs and for the same
//! reason; it opens no window.

#[cfg(target_os = "macos")]
fn main() {
    use muda::accelerator::Accelerator;
    use muda::{Menu, MenuEvent, MenuItem, Submenu};
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType};
    use objc2_foundation::{NSPoint, NSString};
    use tote_lib::app::key_equivalents::read;

    let mtm = MainThreadMarker::new().expect("a test without the harness runs on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    let keys = |s: &str| Some(s.parse::<Accelerator>().unwrap());
    let pad = MenuItem::new("키패드", true, keys("CmdOrCtrl+Numpad1"));
    let row = MenuItem::new("메인 줄", true, keys("CmdOrCtrl+2"));
    let file = Submenu::with_items("파일", true, &[&pad, &row]).unwrap();
    let bar = Menu::with_items(&[&file]).unwrap();
    bar.init_for_nsapp();

    let press = |code: u16, flags: NSEventModifierFlags, chars: &str| {
        let chars = NSString::from_str(chars);
        NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
            NSEventType::KeyDown,
            NSPoint::new(0.0, 0.0),
            flags,
            0.0,
            0,
            None,
            &chars,
            &chars,
            false,
            code,
        )
        .expect("a key event")
    };
    let fired = |event: &NSEvent| {
        while MenuEvent::receiver().try_recv().is_ok() {}
        let handled = app.mainMenu().unwrap().performKeyEquivalent(event);
        let ids: Vec<String> = MenuEvent::receiver()
            .try_iter()
            .map(|e| e.id().0.clone())
            .collect();
        (handled, ids)
    };
    let command = NSEventModifierFlags::Command;
    let keypad = command | NSEventModifierFlags::NumericPad;
    // The flag is on the item; AppKit does not look at it.
    assert_eq!(read(mtm, "파일", "키패드"), Some(("1".to_string(), keypad)));
    // Key codes: 83 keypad 1, 18 main-row 1, 84 keypad 2, 19 main-row 2.
    assert_eq!(
        fired(&press(83, keypad, "1")),
        (true, vec![pad.id().0.clone()])
    );
    assert_eq!(
        fired(&press(18, command, "1")),
        (true, vec![pad.id().0.clone()]),
        "AppKit now tells the keypad from the main row: keypad keys can be recorded as themselves"
    );
    // And the other way: the main-row item answers the keypad, which is why the twin is recorded.
    assert_eq!(
        fired(&press(19, command, "2")),
        (true, vec![row.id().0.clone()])
    );
    assert_eq!(
        fired(&press(84, keypad, "2")),
        (true, vec![row.id().0.clone()])
    );
    println!("menu_keypad: ok");
}

#[cfg(not(target_os = "macos"))]
fn main() {}
