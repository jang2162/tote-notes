//! The threads that answer `tote-file` requests. A fixed few, not one per request: a video seek
//! or a fast scroll through the large text viewer sends dozens of Range requests at once, and a
//! thread each would have them all reading the disk together. Requests past the few wait in the
//! queue.

use std::panic::{self, AssertUnwindSafe};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

const THREADS: usize = 4;

type Job = Box<dyn FnOnce() + Send>;

static QUEUE: OnceLock<Sender<Job>> = OnceLock::new();

/// Runs `f` on one of the pool's threads, started on first use.
pub fn spawn(f: impl FnOnce() + Send + 'static) {
    let queue = QUEUE.get_or_init(|| {
        let (sender, receiver) = mpsc::channel::<Job>();
        let receiver = Arc::new(Mutex::new(receiver));
        for i in 0..THREADS {
            let receiver = Arc::clone(&receiver);
            thread::Builder::new()
                .name(format!("tote-file-{i}"))
                .spawn(move || work(&receiver))
                .expect("spawn a file thread");
        }
        sender
    });
    // The receivers never hang up: the threads run for the life of the process.
    let _ = queue.send(Box::new(f));
}

fn work(receiver: &Mutex<Receiver<Job>>) {
    loop {
        // The lock is held only while taking a job, not while running it.
        let job = receiver
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .recv();
        let Ok(job) = job else { return };
        // A job that panics must not take its thread with it: with every thread gone, no file
        // would load again and nothing would say why.
        let _ = panic::catch_unwind(AssertUnwindSafe(job));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[test]
    fn jobs_run_on_at_most_four_threads_and_all_finish() {
        let running = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        let (done, finished) = mpsc::channel();
        for _ in 0..50 {
            let (running, most, done) = (running.clone(), most.clone(), done.clone());
            spawn(move || {
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                most.fetch_max(now, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(5));
                running.fetch_sub(1, Ordering::SeqCst);
                done.send(()).unwrap();
            });
        }
        for _ in 0..50 {
            finished.recv_timeout(Duration::from_secs(10)).unwrap();
        }
        assert!(most.load(Ordering::SeqCst) <= 4, "{most:?} at once");
    }
}
