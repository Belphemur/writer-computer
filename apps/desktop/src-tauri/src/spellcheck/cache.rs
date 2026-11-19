//! The paragraph cache (ADR 2026-11-18, point 4): the findings of a block, keyed by a hash of its
//! text and allowed ranges and by the language it was checked as. A block that did not change is
//! never checked again, wherever it moved to (findings are stored relative to the block), and a
//! change of language or dialect is a different key. Bounded: when full, the older half goes.

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::ops::Range;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Key {
    hash: u64,
    len: usize,
    lang: String,
}

impl Key {
    pub fn new(text: &[char], allowed: &[Range<usize>], lang: &str) -> Self {
        let mut h = DefaultHasher::new();
        text.hash(&mut h);
        allowed.hash(&mut h);
        Self {
            hash: h.finish(),
            len: text.len(),
            lang: lang.to_string(),
        }
    }
}

pub struct Cache<V> {
    map: HashMap<Key, (u64, Arc<V>)>,
    capacity: usize,
    tick: u64,
}

impl<V> Cache<V> {
    pub fn new(capacity: usize) -> Self {
        Self {
            map: HashMap::new(),
            capacity: capacity.max(2),
            tick: 0,
        }
    }

    pub fn get(&mut self, key: &Key) -> Option<Arc<V>> {
        self.tick += 1;
        let tick = self.tick;
        self.map.get_mut(key).map(|(used, v)| {
            *used = tick;
            v.clone()
        })
    }

    pub fn put(&mut self, key: Key, value: Arc<V>) {
        if self.map.len() >= self.capacity {
            let mut ticks: Vec<u64> = self.map.values().map(|(t, _)| *t).collect();
            ticks.sort_unstable();
            let cutoff = ticks[ticks.len() / 2];
            self.map.retain(|_, (t, _)| *t > cutoff);
        }
        self.tick += 1;
        self.map.insert(key, (self.tick, value));
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn clear(&mut self) {
        self.map.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(text: &str, lang: &str) -> Key {
        let chars: Vec<char> = text.chars().collect();
        Key::new(&chars, &[0..chars.len()], lang)
    }

    #[test]
    fn the_key_is_the_text_the_ranges_and_the_language() {
        assert_eq!(key("same", "en"), key("same", "en"));
        assert_ne!(key("same", "en"), key("same", "en-GB"));
        assert_ne!(key("same", "en"), key("other", "en"));
        let chars: Vec<char> = "same".chars().collect();
        assert_ne!(
            Key::new(&chars, &[0..4], "en"),
            Key::new(&chars, &[0..2], "en")
        );
    }

    #[test]
    fn a_full_cache_drops_the_least_recently_used_half() {
        let mut c: Cache<u32> = Cache::new(4);
        for (i, t) in ["a", "b", "c", "d"].iter().enumerate() {
            c.put(key(t, "en"), Arc::new(i as u32));
        }
        assert!(c.get(&key("a", "en")).is_some(), "touching a keeps it");
        c.put(key("e", "en"), Arc::new(4));
        assert!(c.len() <= 4);
        assert!(c.get(&key("a", "en")).is_some(), "recently used survives");
        assert!(c.get(&key("e", "en")).is_some());
        assert!(c.get(&key("b", "en")).is_none(), "the oldest went");
    }
}
