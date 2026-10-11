//! Bookkeeping for "write everything, then close": closing a window or quitting first asks the
//! affected windows to write their edits (`tote://flush`) and waits until each answers
//! (`flush_done`) — or until a timeout, so a hung page never keeps tote from closing. A window
//! that could not write everything says why in its answer, and the round ends with a question
//! instead of the goal (spec 「오류 처리」: a failed save is the one thing that holds up a quit).

use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FlushGoal {
    CloseWindow(String),
    Quit,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Begin {
    /// Ask these windows to flush, tagged with round `id`.
    Started { id: u64, windows: Vec<String> },
    /// Nobody to wait for: carry the goal out now.
    Done(FlushGoal),
    /// A quit, or this very close, is already waiting — or asking about a failed save.
    AlreadyRunning,
}

/// What an answer, a timeout or a closed window leaves to do.
#[derive(Debug, PartialEq, Eq)]
pub enum Ack {
    /// Nothing yet: windows are still to answer, or the round is no longer running.
    Pending,
    /// Every window wrote what it had: carry the goal out.
    Done(FlushGoal),
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
}

impl FlushCoordinator {
    pub fn begin(&mut self, goal: FlushGoal, windows: Vec<String>) -> Begin {
        let busy = self
            .rounds
            .values()
            .any(|round| round.goal == FlushGoal::Quit || round.goal == goal);
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
        };
        self.rounds.insert(id, round);
        Begin::Started { id, windows }
    }

    /// `window` answered round `id`, with why it is `blocked` if it could not write everything.
    pub fn ack(&mut self, id: u64, window: &str, blocked: Option<String>) -> Ack {
        let Some(round) = self.rounds.get_mut(&id).filter(|round| !round.asking) else {
            return Ack::Pending;
        };
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

    /// Drops round `id` — its question was answered, either way.
    pub fn cancel(&mut self, id: u64) {
        self.rounds.remove(&id);
    }

    fn end(&mut self, id: u64) -> Ack {
        let Some(round) = self.rounds.get_mut(&id) else {
            return Ack::Pending;
        };
        if round.reasons.is_empty() {
            let goal = round.goal.clone();
            self.rounds.remove(&id);
            return Ack::Done(goal);
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
        assert_eq!(f.ack(id, "a", None), Ack::Pending);
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
        assert_eq!(f.ack(id, "hung", None), Ack::Pending);
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
    fn quitting_during_a_close_round_finishes_both() {
        let mut f = FlushCoordinator::default();
        let Begin::Started { id: close, .. } =
            f.begin(FlushGoal::CloseWindow("a".into()), labels(&["a"]))
        else {
            panic!("expected a close round")
        };
        let Begin::Started { id: quit, .. } = f.begin(FlushGoal::Quit, labels(&["a", "b"])) else {
            panic!("expected a quit round")
        };
        assert_eq!(
            f.ack(close, "a", None),
            Ack::Done(FlushGoal::CloseWindow("a".into()))
        );
        assert_eq!(f.window_gone("a"), vec![]);
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
        // A late answer to the dropped round is ignored, and a new quit starts afresh.
        assert_eq!(f.ack(id, "a", None), Ack::Pending);
        assert_eq!(f.expire(id), Ack::Pending);
        assert!(matches!(
            f.begin(FlushGoal::Quit, labels(&["a"])),
            Begin::Started { id: next, .. } if next != id
        ));
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
