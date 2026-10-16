//! When a failing backup is worth telling the person about (spec 「오류 처리」): once per window,
//! again a day later if it keeps failing, and again after the window was closed and reopened.
//!
//! The day is measured by the wall clock: an `Instant` stops while a Mac sleeps, so a person's
//! "a day" would stretch over every night the lid was closed.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, SystemTime};

/// A failure that goes on is told again this often.
pub const RENOTIFY: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Default)]
pub struct FailureNotices {
    /// Window label -> when it was last told.
    told: HashMap<String, SystemTime>,
}

impl FailureNotices {
    pub fn new() -> Self {
        Self::default()
    }

    /// True when the person should be told about this failure now.
    pub fn failed(&mut self, label: &str, now: SystemTime) -> bool {
        match self.told.get(label) {
            // A clock set back makes `duration_since` fail; that tells again rather than stay quiet.
            Some(&last) if now.duration_since(last).is_ok_and(|since| since < RENOTIFY) => false,
            _ => {
                self.told.insert(label.to_string(), now);
                true
            }
        }
    }

    pub fn succeeded(&mut self, label: &str) {
        self.told.remove(label);
    }

    /// A window was just opened. Its label comes from its path, so one closed and reopened between
    /// two rounds looks open throughout; forget it here so a failing backup is told again.
    pub fn opened(&mut self, label: &str) {
        self.told.remove(label);
    }

    /// Forget windows that are no longer open.
    pub fn retain_open(&mut self, open: &HashSet<String>) {
        self.told.retain(|label, _| open.contains(label));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: Duration = Duration::from_secs(60);

    #[test]
    fn the_first_failure_is_told() {
        let mut notices = FailureNotices::new();
        let t = SystemTime::now();
        assert!(notices.failed("a", t));
        assert!(!notices.failed("a", t + 10 * MINUTE));
    }

    #[test]
    fn a_continuing_failure_is_told_again_after_a_day() {
        let mut notices = FailureNotices::new();
        let t = SystemTime::now();
        assert!(notices.failed("a", t));
        assert!(notices.failed("a", t + RENOTIFY));
        assert!(!notices.failed("a", t + RENOTIFY + MINUTE));
    }

    #[test]
    fn a_clock_set_back_tells_again() {
        let mut notices = FailureNotices::new();
        let t = SystemTime::now();
        assert!(notices.failed("a", t));
        assert!(notices.failed("a", t - 60 * MINUTE));
    }

    #[test]
    fn a_success_resets_it() {
        let mut notices = FailureNotices::new();
        let t = SystemTime::now();
        assert!(notices.failed("a", t));
        notices.succeeded("a");
        assert!(notices.failed("a", t + MINUTE));
    }

    #[test]
    fn a_reopened_window_is_told_again() {
        let mut notices = FailureNotices::new();
        let t = SystemTime::now();
        assert!(notices.failed("a", t));
        notices.retain_open(&HashSet::new());
        assert!(notices.failed("a", t + MINUTE));
    }

    #[test]
    fn a_window_reopened_between_ticks_is_told_again() {
        let mut notices = FailureNotices::new();
        let t = SystemTime::now();
        assert!(notices.failed("a", t));
        notices.opened("a");
        assert!(notices.failed("a", t + MINUTE));
    }

    #[test]
    fn other_windows_are_kept() {
        let mut notices = FailureNotices::new();
        let t = SystemTime::now();
        assert!(notices.failed("a", t));
        assert!(notices.failed("b", t));
        notices.retain_open(&HashSet::from(["b".to_string()]));
        assert!(!notices.failed("b", t + MINUTE));
    }
}
