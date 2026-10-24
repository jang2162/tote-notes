//! A shortcut taken off a menu bar item really leaves the `NSMenuItem` (src/app/key_equivalents.rs).
//! muda makes AppKit menus on the main thread only, and the test harness runs tests on threads of
//! its own: this file is its own `main` (`harness = false` in Cargo.toml). It sets the menu bar of
//! the test process and opens no window.

#[cfg(target_os = "macos")]
fn main() {
    use muda::accelerator::Accelerator;
    use muda::{Menu, MenuItem, Submenu};
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSEventModifierFlags};
    use tote_lib::app::key_equivalents::{clear, read};

    let mtm = MainThreadMarker::new().expect("a test without the harness runs on the main thread");
    NSApplication::sharedApplication(mtm);
    let keys = |s: &str| Some(s.parse::<Accelerator>().unwrap());
    let new_memo = MenuItem::new("새 메모", true, keys("CmdOrCtrl+N"));
    let save = MenuItem::new("저장", true, keys("CmdOrCtrl+S"));
    // An item of the same name in another submenu, which `clear` must leave alone.
    let elsewhere = MenuItem::new("새 메모", true, keys("CmdOrCtrl+Shift+N"));
    let file = Submenu::with_items("파일", true, &[&new_memo, &save]).unwrap();
    let view = Submenu::with_items("보기", true, &[&elsewhere]).unwrap();
    let bar = Menu::with_items(&[&file, &view]).unwrap();
    bar.init_for_nsapp();

    let command = NSEventModifierFlags::Command;
    assert_eq!(
        read(mtm, "파일", "새 메모"),
        Some(("n".to_string(), command))
    );

    // The reason `clear` exists. When muda takes the key off itself this fails, and
    // key_equivalents.rs can go.
    new_memo.set_accelerator(None).unwrap();
    assert_eq!(
        read(mtm, "파일", "새 메모"),
        Some(("n".to_string(), command)),
        "muda now takes a shortcut off: src/app/key_equivalents.rs is no longer needed"
    );

    assert!(clear(mtm, "파일", "새 메모"));
    assert_eq!(
        read(mtm, "파일", "새 메모"),
        Some((String::new(), NSEventModifierFlags::empty()))
    );
    assert_eq!(read(mtm, "파일", "저장"), Some(("s".to_string(), command)));
    assert_eq!(
        read(mtm, "보기", "새 메모"),
        Some(("n".to_string(), command | NSEventModifierFlags::Shift))
    );

    // muda puts a shortcut back on as before.
    new_memo
        .set_accelerator(keys("Alt+CmdOrCtrl+Shift+M"))
        .unwrap();
    assert_eq!(
        read(mtm, "파일", "새 메모"),
        Some((
            "m".to_string(),
            command | NSEventModifierFlags::Shift | NSEventModifierFlags::Option
        ))
    );

    assert!(!clear(mtm, "파일", "없는 항목"));
    assert!(!clear(mtm, "없는 메뉴", "새 메모"));
    println!("menu_key_equivalents: ok");
}

#[cfg(not(target_os = "macos"))]
fn main() {}
