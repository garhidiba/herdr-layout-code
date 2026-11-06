//! A scoped worker pool: maps `f` over `items` on up to one thread per core, keeping the input order.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;

pub fn map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let threads = thread::available_parallelism().map_or(4, |n| n.get()).min(items.len());
    if threads <= 1 {
        return items.iter().map(f).collect();
    }
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<R>>> = Mutex::new((0..items.len()).map(|_| None).collect());
    thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(item) = items.get(i) else { break };
                let r = f(item);
                results.lock().unwrap()[i] = Some(r);
            });
        }
    });
    results.into_inner().unwrap().into_iter().map(|r| r.expect("every item is mapped")).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn keeps_the_input_order() {
        let items: Vec<u32> = (0..100).collect();
        assert_eq!(super::map(&items, |n| n * 2), (0..100).map(|n| n * 2).collect::<Vec<_>>());
    }
}
