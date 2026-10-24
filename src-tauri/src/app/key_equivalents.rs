//! The shortcut of a menu bar item, read and taken off in AppKit directly. muda 0.20 (and 0.21.2,
//! the newest) sets an item's key equivalent only when it is given a shortcut: `set_accelerator`
//! with none leaves the old one on the `NSMenuItem` (`MenuChild::set_accelerator`,
//! src/platform_impl/macos/mod.rs). Through tauri alone a shortcut set to 「없음」, or taken off
//! while a window records one, keeps working. tests/menu_key_equivalents.rs fails once muda takes
//! the key off itself.
//!
//! An item is found by the title of its submenu in the menu bar and its own title, which
//! `menu::MENUS` keeps unique within a submenu. Main thread only, as AppKit wants.

use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSEventModifierFlags, NSMenuItem};
use objc2_foundation::NSString;

fn find(mtm: MainThreadMarker, menu: &str, item: &str) -> Option<Retained<NSMenuItem>> {
    let bar = NSApplication::sharedApplication(mtm).mainMenu()?;
    let submenu = bar.itemWithTitle(&NSString::from_str(menu))?.submenu()?;
    submenu.itemWithTitle(&NSString::from_str(item))
}

/// Takes the shortcut off item `item` of submenu `menu`. False if the menu bar has no such item.
pub fn clear(mtm: MainThreadMarker, menu: &str, item: &str) -> bool {
    let Some(found) = find(mtm, menu, item) else {
        return false;
    };
    found.setKeyEquivalent(&NSString::new());
    found.setKeyEquivalentModifierMask(NSEventModifierFlags::empty());
    true
}

/// The key equivalent of item `item` of submenu `menu` and its modifier mask, as AppKit reads it:
/// an empty key is no shortcut. For the tests.
pub fn read(
    mtm: MainThreadMarker,
    menu: &str,
    item: &str,
) -> Option<(String, NSEventModifierFlags)> {
    let found = find(mtm, menu, item)?;
    Some((
        found.keyEquivalent().to_string(),
        found.keyEquivalentModifierMask(),
    ))
}
