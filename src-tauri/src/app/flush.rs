//! Bookkeeping for "write everything, then close": closing a window or quitting first asks the
//! affected windows to write their edits (`tote://flush`) and waits until each answers
//! (`flush_done`) — or until a timeout, so a hung page never keeps tote from closing. A window
//! that could not write everything says why in its answer, and the round ends with a question
//! instead of the goal (spec 「오류 처리」: a failed save is the one thing that holds up a quit).
//!
//! Closing a window and switching its workspace are window rounds: one window writes, and a
//! window runs one window round at a time. A quit never runs beside a window round: a quit that
//! comes while one is open — still writing or asking — joins it and starts once it is done
//! (`Ack::DoneThenQuit`), or shares its question; a window round that comes while a quit round
//! runs is absorbed by it. So a quit and a window round never ask at once, and every quit macOS
//! waits on is answered by one round's end.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FlushGoal {
    CloseWindow(String),
    /// The window `label` shows the workspace at `to` instead of its own.
    SwitchWorkspace {
        label: String,
        to: PathBuf,
    },
    Quit,
}

impl FlushGoal {
    /// What the round is for, as `tote://flush` tells the page: a page that writes its tabs to
    /// close or switch lets go of them as it answers (`AppController.onFlush`), a quitting one
    /// does not.
    pub fn kind(&self) -> &'static str {
        match self {
            FlushGoal::CloseWindow(_) => "close",
            FlushGoal::SwitchWorkspace { .. } => "switch",
            FlushGoal::Quit => "quit",
        }
    }

    /// The window of a window round; `None` for a quit.
    pub fn window(&self) -> Option<&str> {
        match self {
            FlushGoal::CloseWindow(label) | FlushGoal::SwitchWorkspace { label, .. } => Some(label),
            FlushGoal::Quit => None,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Begin {
    /// Ask these windows to flush, tagged with round `id`.
    Started { id: u64, windows: Vec<String> },
    /// Nobody to wait for: carry the goal out now.
    Done(FlushGoal),
    /// A round already covers this goal: a quit round absorbs a window round and a second quit, a
    /// window's round absorbs any other round of that window, and a quit that finds a window
    /// round — writing or asking — joins the first one opened and starts when it is done.
    AlreadyRunning,
}

/// What an answer, a timeout or a closed window leaves to do.
#[derive(Debug, PartialEq, Eq)]
pub enum Ack {
    /// Nothing yet: windows are still to answer, the round asks, or it is no longer running.
    Pending,
    /// An answer to a round that is over: it timed out, or its question was answered. The page
    /// that answered emptied its panes for nothing if its window is not going after all.
    Stale,
    /// Every window wrote what it had: carry the goal out.
    Done(FlushGoal),
    /// The window round a quit joined wrote everything: carry it out, then start the quit.
    DoneThenQuit(FlushGoal),
    /// Some window could not write everything: ask before carrying the goal out. The round stays
    /// until `cancel`, so a second ⌘Q while the question is open starts nothing.
    Blocked {
        goal: FlushGoal,
        reasons: Vec<String>,
    },
}

#[derive(Default)]
pub struct FlushCoordinator {
    next_id: u64,
    rounds: BTreeMap<u64, Round>,
}

struct Round {
    goal: FlushGoal,
    waiting: BTreeSet<String>,
    /// Why windows that answered could not write everything.
    reasons: Vec<String>,
    /// Ended as `Ack::Blocked`; the question is open.
    asking: bool,
    /// A quit came while this window round was open: its end starts the quit, or its question's
    /// answer carries the quit on or refuses it.
    quit_waiting: bool,
}

impl FlushCoordinator {
    pub fn begin(&mut self, goal: FlushGoal, windows: Vec<String>) -> Begin {
        // A quit beside a window round could end in two dialogs at once, one per round; the quit
        // waits on the window round instead, writing or asking. Rounds are kept in id order, so
        // with several the first opened takes it. A quit round already running wins: it absorbs
        // this one below, and a window round's 「취소」 must not refuse it.
        let quit_running = self
            .rounds
            .values()
            .any(|round| round.goal == FlushGoal::Quit);
        if goal == FlushGoal::Quit && !quit_running {
            let window_round = self
                .rounds
                .values_mut()
                .find(|round| round.goal.window().is_some());
            if let Some(round) = window_round {
                round.quit_waiting = true;
                return Begin::AlreadyRunning;
            }
        }
        // A Dock quit or a logout told 「later」 here still owes macOS an answer: whichever round
        // absorbed it answers when it ends.
        let busy = quit_running
            || self.rounds.values().any(|round| {
                round.goal == goal
                    || (goal.window().is_some() && round.goal.window() == goal.window())
            });
        if busy {
            return Begin::AlreadyRunning;
        }
        if windows.is_empty() {
            return Begin::Done(goal);
        }
        self.next_id += 1;
        let id = self.next_id;
        let round = Round {
            goal,
            waiting: windows.iter().cloned().collect(),
            reasons: Vec::new(),
            asking: false,
            quit_waiting: false,
        };
        self.rounds.insert(id, round);
        Begin::Started { id, windows }
    }

    /// `window` answered round `id`, with why it is `blocked` if it could not write everything.
    pub fn ack(&mut self, id: u64, window: &str, blocked: Option<String>) -> Ack {
        let Some(round) = self.rounds.get_mut(&id) else {
            return Ack::Stale;
        };
        if round.asking {
            return Ack::Pending;
        }
        // A second answer from the same window adds nothing.
        if round.waiting.remove(window) {
            round.reasons.extend(blocked);
        }
        if round.waiting.is_empty() {
            self.end(id)
        } else {
            Ack::Pending
        }
    }

    /// Round `id` ran out of time. A hung window does not hold up the goal, but a reason already
    /// given still does: the failed save is there whether or not the other windows answered.
    pub fn expire(&mut self, id: u64) -> Ack {
        match self.rounds.get(&id) {
            Some(round) if !round.asking => self.end(id),
            _ => Ack::Pending,
        }
    }

    /// `window` is gone; it counts as having answered every round, with nothing to report.
    /// Returns the rounds that ended, by id.
    pub fn window_gone(&mut self, window: &str) -> Vec<(u64, Ack)> {
        let finished: Vec<u64> = self
            .rounds
            .iter_mut()
            .filter(|(_, round)| !round.asking)
            .filter_map(|(id, round)| {
                round.waiting.remove(window);
                round.waiting.is_empty().then_some(*id)
            })
            .collect();
        finished.into_iter().map(|id| (id, self.end(id))).collect()
    }

    /// A window round — a close or a switch — is asking, on a sheet over its window. AppKit's own
    /// quit Apple Event handler would refuse a Dock or AppleScript quit while a sheet is up, never
    /// asking tote; `system_quit` takes that event instead and holds the quit for this question.
    pub fn asking_close(&self) -> bool {
        self.rounds
            .values()
            .any(|round| round.asking && round.goal.window().is_some())
    }

    /// A round closing window `label` or switching its workspace is open, writing or asking. Its
    /// page may answer before a tab handed to it arrives and write its tabs without it, and the
    /// tab would go with the window. A quit round targets no window: every window stays.
    pub fn targets(&self, label: &str) -> bool {
        self.rounds
            .values()
            .any(|round| round.goal.window() == Some(label))
    }

    /// Drops round `id` — its question was answered, either way. True when a quit was waiting on
    /// it.
    pub fn cancel(&mut self, id: u64) -> bool {
        self.rounds
            .remove(&id)
            .is_some_and(|round| round.quit_waiting)
    }

    fn end(&mut self, id: u64) -> Ack {
        let Some(round) = self.rounds.get_mut(&id) else {
            return Ack::Pending;
        };
        if round.reasons.is_empty() {
            let goal = round.goal.clone();
            let quit = round.quit_waiting;
            self.rounds.remove(&id);
            return if quit {
                Ack::DoneThenQuit(goal)
            } else {
                Ack::Done(goal)
            };
        }
        round.asking = true;
        Ack::Blocked {
            goal: round.goal.clone(),
            reasons: round.reasons.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn labels(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    const ONE_FAILED: &str = "저장하지 못한 메모 1개";

    #[test]
    fn a_close_waits_for_its_window() {
        let mut f = FlushCoordinator::default();
        let Begin::Started { id, windows } =
            f.begin(FlushGoal::CloseWindow("a".into()), labels(&["a"]))
        else {
            panic!("expected a round")
        };
        assert_eq!(windows, labels(&["a"]));
        assert_eq!(
            f.ack(id, "a", None),
            Ack::Done(FlushGoal::CloseWindow("a".into()))
        );
        assert_eq!(f.ack(id, "a", None), Ack::Stale);
    }

    #[test]
    fn a_quit_waits_for_every_window() {
        let mut f = FlushCoordinator::default();
        let Begin::Started { id, .. } = f.begin(FlushGoal::Quit, labels(&["a", "b"])) else {
            panic!("expected a round")
        };
        assert_eq!(f.ack(id, "a", None), Ack::Pending);
        assert_eq!(f.ack(id, "b", None), Ack::Done(FlushGoal::Quit));
    }

    #[test]
    fn nothing_to_wait_for_is_done_at_once() {
        let mut f = FlushCoordinator::default();
        assert_eq!(
            f.begin(FlushGoal::Quit, vec![]),
            Begin::Done(FlushGoal::Quit)
        );
    }

    #[test]
    fn a_running_quit_absorbs_new_requests() {
        let mut f = FlushCoordinator::default();
        assert!(matches!(
            f.begin(FlushGoal::Quit, labels(&["a"])),
            Begin::Started { .. }
        ));
        assert_eq!(
            f.begin(FlushGoal::Quit, labels(&["a"])),
            Begin::AlreadyRunning
        );
        assert_eq!(
            f.begin(FlushGoal::CloseWindow("a".into()), labels(&["a"])),
            Begin::AlreadyRunning
        );
    }

    #[test]
    fn a_round_that_times_out_still_finishes() {
        let mut f = FlushCoordinator::default();
        let Begin::Started { id, .. } = f.begin(FlushGoal::Quit, labels(&["hung"])) else {
            panic!("expected a round")
        };
        assert_eq!(f.expire(id), Ack::Done(FlushGoal::Quit));
        assert_eq!(f.expire(id), Ack::Pending);
        assert_eq!(f.ack(id, "hung", None), Ack::Stale);
    }

    #[test]
    fn an_answer_for_an_ended_round_is_stale() {
        let mut f = FlushCoordinator::default();
        let Begin::Started { id, .. } = f.begin(switch("a"), labels(&["a"])) else {
            panic!("expected a round")
        };
        assert_eq!(f.expire(id), Ack::Done(switch("a")));
        assert_eq!(f.ack(id, "a", None), Ack::Stale);
        // A round still asking is not over: its question gives the window back or carries it out.
        let id = asking_close(&mut f);
        assert_eq!(f.ack(id, "a", None), Ack::Pending);
    }

    #[test]
    fn a_window_round_targets_its_window_until_it_is_dropped() {
        let mut f = FlushCoordinator::default();
        let Begin::Started { id, .. } = f.begin(FlushGoal::CloseWindow("a".into()), labels(&["a"]))
        else {
            panic!("expected a round")
        };
        assert!(f.targets("a"));
        assert!(!f.targets("b"));
        // Still while it asks: 「그래도 닫기」 takes the window.
        assert!(matches!(
            f.ack(id, "a", Some(ONE_FAILED.into())),
            Ack::Blocked { .. }
        ));
        assert!(f.targets("a"));
        f.cancel(id);
        assert!(!f.targets("a"));
        let Begin::Started { .. } = f.begin(FlushGoal::Quit, labels(&["a", "b"])) else {
            panic!("expected a round")
        };
        assert!(!f.targets("a"));
        assert!(!f.targets("b"));
    }

    #[test]
    fn a_closed_window_counts_as_answered() {
        let mut f = FlushCoordinator::default();
        let Begin::Started { id, .. } = f.begin(FlushGoal::Quit, labels(&["a", "b"])) else {
            panic!("expected a round")
        };
        assert_eq!(f.ack(id, "a", None), Ack::Pending);
        assert_eq!(f.window_gone("b"), vec![(id, Ack::Done(FlushGoal::Quit))]);
    }

    #[test]
    fn a_quit_during_a_close_round_waits_for_it() {
        let mut f = FlushCoordinator::default();
        let Begin::Started { id: close, .. } =
            f.begin(FlushGoal::CloseWindow("a".into()), labels(&["a"]))
        else {
            panic!("expected a close round")
        };
        // The quit opens no round of its own: it starts once the close is done.
        assert_eq!(
            f.begin(FlushGoal::Quit, labels(&["a", "b"])),
            Begin::AlreadyRunning
        );
        assert_eq!(
            f.ack(close, "a", None),
            Ack::DoneThenQuit(FlushGoal::CloseWindow("a".into()))
        );
        assert_eq!(f.window_gone("a"), vec![]);
        // The quit joined to the close is not still running: it opens its own round.
        assert!(matches!(
            f.begin(FlushGoal::Quit, labels(&["b"])),
            Begin::Started { .. }
        ));
    }

    #[test]
    fn a_close_during_a_running_quit_is_absorbed() {
        let mut f = FlushCoordinator::default();
        let Begin::Started { id: quit, .. } = f.begin(FlushGoal::Quit, labels(&["a", "b"])) else {
            panic!("expected a quit round")
        };
        assert_eq!(
            f.begin(FlushGoal::CloseWindow("a".into()), labels(&["a"])),
            Begin::AlreadyRunning
        );
        assert_eq!(f.ack(quit, "a", None), Ack::Pending);
        assert_eq!(f.ack(quit, "b", None), Ack::Done(FlushGoal::Quit));
    }

    #[test]
    fn a_blocked_ack_ends_the_round_as_blocked_with_its_reasons() {
        let mut f = FlushCoordinator::default();
        let Begin::Started { id, .. } = f.begin(FlushGoal::Quit, labels(&["a", "b"])) else {
            panic!("expected a round")
        };
        assert_eq!(f.ack(id, "a", Some(ONE_FAILED.into())), Ack::Pending);
        assert_eq!(
            f.ack(id, "b", None),
            Ack::Blocked {
                goal: FlushGoal::Quit,
                reasons: vec![ONE_FAILED.into()],
            }
        );
    }

    #[test]
    fn a_blocked_round_ends_with_a_cancel() {
        let mut f = FlushCoordinator::default();
        let Begin::Started { id, .. } = f.begin(FlushGoal::Quit, labels(&["a"])) else {
            panic!("expected a round")
        };
        assert!(matches!(
            f.ack(id, "a", Some(ONE_FAILED.into())),
            Ack::Blocked { .. }
        ));
        // The question is open: another ⌘Q starts nothing.
        assert_eq!(
            f.begin(FlushGoal::Quit, labels(&["a"])),
            Begin::AlreadyRunning
        );
        f.cancel(id);
        // A late answer to the dropped round is stale, and a new quit starts afresh.
        assert_eq!(f.ack(id, "a", None), Ack::Stale);
        assert_eq!(f.expire(id), Ack::Pending);
        assert!(matches!(
            f.begin(FlushGoal::Quit, labels(&["a"])),
            Begin::Started { id: next, .. } if next != id
        ));
    }

    /// Round `id` closing window "a", ended as `Ack::Blocked`: its question is open.
    fn asking_close(f: &mut FlushCoordinator) -> u64 {
        let Begin::Started { id, .. } = f.begin(FlushGoal::CloseWindow("a".into()), labels(&["a"]))
        else {
            panic!("expected a round")
        };
        assert!(matches!(
            f.ack(id, "a", Some(ONE_FAILED.into())),
            Ack::Blocked { .. }
        ));
        id
    }

    #[test]
    fn a_quit_joins_an_asking_close() {
        let mut f = FlushCoordinator::default();
        let id = asking_close(&mut f);
        // No second dialog: the quit waits on the question already open.
        assert_eq!(
            f.begin(FlushGoal::Quit, labels(&["a", "b"])),
            Begin::AlreadyRunning
        );
        assert!(f.cancel(id));
    }

    #[test]
    fn asking_close_is_true_only_while_a_close_asks() {
        let mut f = FlushCoordinator::default();
        let Begin::Started { id: writing, .. } =
            f.begin(FlushGoal::CloseWindow("b".into()), labels(&["b"]))
        else {
            panic!("expected a round")
        };
        // Still writing: no sheet is up yet.
        assert!(!f.asking_close());
        let id = asking_close(&mut f);
        assert!(f.asking_close());
        f.cancel(id);
        assert!(!f.asking_close());
        f.cancel(writing);

        // A switch asks on a sheet too.
        let Begin::Started { id, .. } = f.begin(switch("a"), labels(&["a"])) else {
            panic!("expected a round")
        };
        f.ack(id, "a", Some(ONE_FAILED.into()));
        assert!(f.asking_close());
        f.cancel(id);

        // A quit's question is not on a window.
        let Begin::Started { id, .. } = f.begin(FlushGoal::Quit, labels(&["a"])) else {
            panic!("expected a round")
        };
        f.ack(id, "a", Some(ONE_FAILED.into()));
        assert!(!f.asking_close());
    }

    #[test]
    fn cancelling_an_asking_close_without_a_quit_reports_none() {
        let mut f = FlushCoordinator::default();
        let id = asking_close(&mut f);
        assert!(!f.cancel(id));
    }

    #[test]
    fn the_first_asking_close_takes_the_quit() {
        let mut f = FlushCoordinator::default();
        let a = asking_close(&mut f);
        let Begin::Started { id: b, .. } =
            f.begin(FlushGoal::CloseWindow("b".into()), labels(&["b"]))
        else {
            panic!("expected a round")
        };
        assert!(matches!(
            f.ack(b, "b", Some(ONE_FAILED.into())),
            Ack::Blocked { .. }
        ));
        assert_eq!(
            f.begin(FlushGoal::Quit, labels(&["a", "b"])),
            Begin::AlreadyRunning
        );
        assert!(f.cancel(a));
        assert!(!f.cancel(b));
    }

    /// Round `id` closing window "a", still waiting for its answer, with a quit joined to it.
    fn writing_close_with_a_quit(f: &mut FlushCoordinator) -> u64 {
        let Begin::Started { id, .. } = f.begin(FlushGoal::CloseWindow("a".into()), labels(&["a"]))
        else {
            panic!("expected a round")
        };
        assert_eq!(
            f.begin(FlushGoal::Quit, labels(&["a", "b"])),
            Begin::AlreadyRunning
        );
        id
    }

    #[test]
    fn a_quit_joins_a_close_still_writing() {
        let mut f = FlushCoordinator::default();
        let id = writing_close_with_a_quit(&mut f);
        assert_eq!(
            f.ack(id, "a", None),
            Ack::DoneThenQuit(FlushGoal::CloseWindow("a".into()))
        );
    }

    #[test]
    fn a_writing_close_that_fails_asks_once_for_both() {
        let mut f = FlushCoordinator::default();
        let id = writing_close_with_a_quit(&mut f);
        assert!(matches!(
            f.ack(id, "a", Some(ONE_FAILED.into())),
            Ack::Blocked { .. }
        ));
        assert!(f.cancel(id));
    }

    #[test]
    fn a_writing_close_that_times_out_still_quits() {
        let mut f = FlushCoordinator::default();
        let id = writing_close_with_a_quit(&mut f);
        assert_eq!(
            f.expire(id),
            Ack::DoneThenQuit(FlushGoal::CloseWindow("a".into()))
        );
    }

    #[test]
    fn a_closed_window_ends_its_round_and_starts_the_quit() {
        let mut f = FlushCoordinator::default();
        let id = writing_close_with_a_quit(&mut f);
        assert_eq!(
            f.window_gone("a"),
            vec![(id, Ack::DoneThenQuit(FlushGoal::CloseWindow("a".into())))]
        );
    }

    fn switch(label: &str) -> FlushGoal {
        FlushGoal::SwitchWorkspace {
            label: label.into(),
            to: PathBuf::from("/w/나"),
        }
    }

    #[test]
    fn one_window_runs_one_window_round_at_a_time() {
        let mut f = FlushCoordinator::default();
        assert!(matches!(
            f.begin(switch("w1"), labels(&["w1"])),
            Begin::Started { .. }
        ));
        assert_eq!(
            f.begin(FlushGoal::CloseWindow("w1".into()), labels(&["w1"])),
            Begin::AlreadyRunning
        );
        assert_eq!(
            f.begin(switch("w1"), labels(&["w1"])),
            Begin::AlreadyRunning
        );
        assert!(matches!(
            f.begin(FlushGoal::CloseWindow("w2".into()), labels(&["w2"])),
            Begin::Started { .. }
        ));
    }

    #[test]
    fn a_quit_joins_a_switch_like_a_close() {
        // Still writing: the quit starts once the switch is done.
        let mut f = FlushCoordinator::default();
        let Begin::Started { id, .. } = f.begin(switch("a"), labels(&["a"])) else {
            panic!("expected a round")
        };
        assert_eq!(
            f.begin(FlushGoal::Quit, labels(&["a", "b"])),
            Begin::AlreadyRunning
        );
        assert_eq!(f.ack(id, "a", None), Ack::DoneThenQuit(switch("a")));

        // Asking: one question answers both.
        let mut f = FlushCoordinator::default();
        let Begin::Started { id, .. } = f.begin(switch("a"), labels(&["a"])) else {
            panic!("expected a round")
        };
        assert!(matches!(
            f.ack(id, "a", Some(ONE_FAILED.into())),
            Ack::Blocked { .. }
        ));
        assert_eq!(
            f.begin(FlushGoal::Quit, labels(&["a", "b"])),
            Begin::AlreadyRunning
        );
        assert!(f.cancel(id));
    }

    #[test]
    fn a_round_that_times_out_after_a_blocked_answer_still_asks() {
        let mut f = FlushCoordinator::default();
        let Begin::Started { id, .. } = f.begin(FlushGoal::Quit, labels(&["a", "hung"])) else {
            panic!("expected a round")
        };
        assert_eq!(f.ack(id, "a", Some(ONE_FAILED.into())), Ack::Pending);
        assert_eq!(
            f.expire(id),
            Ack::Blocked {
                goal: FlushGoal::Quit,
                reasons: vec![ONE_FAILED.into()],
            }
        );
        // The open question is not asked again by the window that hung going away.
        assert_eq!(f.window_gone("hung"), vec![]);
        assert_eq!(f.expire(id), Ack::Pending);
    }
}
