//! Bookkeeping for "write everything, then close": closing a window or quitting first asks the
//! affected windows to write their edits (`tote://flush`) and waits until each answers
//! (`flush_done`) — or until a timeout, so a hung page never keeps tote from closing.

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
    /// A quit, or this very close, is already waiting.
    AlreadyRunning,
}

#[derive(Default)]
pub struct FlushCoordinator {
    next_id: u64,
    rounds: BTreeMap<u64, Round>,
}

struct Round {
    goal: FlushGoal,
    waiting: BTreeSet<String>,
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
        let waiting = windows.iter().cloned().collect();
        self.rounds.insert(id, Round { goal, waiting });
        Begin::Started { id, windows }
    }

    /// `window` answered round `id`; returns the goal once nobody is left to wait for.
    pub fn ack(&mut self, id: u64, window: &str) -> Option<FlushGoal> {
        let round = self.rounds.get_mut(&id)?;
        round.waiting.remove(window);
        if round.waiting.is_empty() {
            self.rounds.remove(&id).map(|round| round.goal)
        } else {
            None
        }
    }

    /// Round `id` ran out of time: returns its goal if it was still waiting.
    pub fn expire(&mut self, id: u64) -> Option<FlushGoal> {
        self.rounds.remove(&id).map(|round| round.goal)
    }

    /// `window` is gone; it counts as having answered every round.
    pub fn window_gone(&mut self, window: &str) -> Vec<FlushGoal> {
        let finished: Vec<u64> = self
            .rounds
            .iter_mut()
            .filter_map(|(id, round)| {
                round.waiting.remove(window);
                round.waiting.is_empty().then_some(*id)
            })
            .collect();
        finished
            .into_iter()
            .filter_map(|id| self.rounds.remove(&id).map(|round| round.goal))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_close_waits_for_its_window() {
        let mut f = FlushCoordinator::default();
        let Begin::Started { id, windows } =
            f.begin(FlushGoal::CloseWindow("a".into()), labels(&["a"]))
        else {
            panic!("expected a round")
        };
        assert_eq!(windows, labels(&["a"]));
        assert_eq!(f.ack(id, "a"), Some(FlushGoal::CloseWindow("a".into())));
        assert_eq!(f.ack(id, "a"), None);
    }

    #[test]
    fn a_quit_waits_for_every_window() {
        let mut f = FlushCoordinator::default();
        let Begin::Started { id, .. } = f.begin(FlushGoal::Quit, labels(&["a", "b"])) else {
            panic!("expected a round")
        };
        assert_eq!(f.ack(id, "a"), None);
        assert_eq!(f.ack(id, "b"), Some(FlushGoal::Quit));
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
        assert_eq!(f.expire(id), Some(FlushGoal::Quit));
        assert_eq!(f.expire(id), None);
        assert_eq!(f.ack(id, "hung"), None);
    }

    #[test]
    fn a_closed_window_counts_as_answered() {
        let mut f = FlushCoordinator::default();
        let Begin::Started { id, .. } = f.begin(FlushGoal::Quit, labels(&["a", "b"])) else {
            panic!("expected a round")
        };
        assert_eq!(f.ack(id, "a"), None);
        assert_eq!(f.window_gone("b"), vec![FlushGoal::Quit]);
    }
}
