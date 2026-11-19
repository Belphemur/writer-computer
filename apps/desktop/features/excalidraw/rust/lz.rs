//! `compressToBase64` / `decompressFromBase64` of lz-string 1.5.0 (MIT), the encoding of the
//! `compressed-json` block of a drawing. Written here because the crate is not a dependency; the
//! TypeScript codec uses the library itself, and `shared/excalidraw-fixtures/lz-vectors.json`
//! (made with the library) holds both to the same output. Text is handled as UTF-16 code units,
//! like the JavaScript original, so a surrogate pair is two characters in both.

use std::collections::{HashMap, HashSet};

const ALPHABET: &[u8; 65] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
const BITS: u32 = 6;

struct Writer {
    out: Vec<u8>,
    value: u32,
    position: u32,
}

impl Writer {
    /// `count` bits of `value`, lowest bit first.
    fn bits(&mut self, mut value: u32, count: u32) {
        for _ in 0..count {
            self.value = (self.value << 1) | (value & 1);
            if self.position == BITS - 1 {
                self.position = 0;
                self.out.push(ALPHABET[self.value as usize]);
                self.value = 0;
            } else {
                self.position += 1;
            }
            value >>= 1;
        }
    }

    fn flush(&mut self) {
        loop {
            self.value <<= 1;
            if self.position == BITS - 1 {
                self.out.push(ALPHABET[self.value as usize]);
                return;
            }
            self.position += 1;
        }
    }
}

struct Coder {
    writer: Writer,
    enlarge_in: u32,
    num_bits: u32,
    to_create: HashSet<u16>,
    dictionary: HashMap<Vec<u16>, u32>,
}

impl Coder {
    fn grow(&mut self) {
        self.enlarge_in -= 1;
        if self.enlarge_in == 0 {
            self.enlarge_in = 1 << self.num_bits;
            self.num_bits += 1;
        }
    }

    /// The output for the phrase `w`: its literal character the first time, its code after.
    fn emit(&mut self, w: &[u16]) {
        if w.len() == 1 && self.to_create.remove(&w[0]) {
            let ch = u32::from(w[0]);
            if ch < 256 {
                self.writer.bits(0, self.num_bits);
                self.writer.bits(ch, 8);
            } else {
                self.writer.bits(1, self.num_bits);
                self.writer.bits(ch, 16);
            }
            self.grow();
        } else {
            let code = self.dictionary[w];
            self.writer.bits(code, self.num_bits);
        }
        self.grow();
    }
}

pub fn compress_to_base64(input: &str) -> String {
    let mut coder = Coder {
        writer: Writer {
            out: Vec::new(),
            value: 0,
            position: 0,
        },
        enlarge_in: 2,
        num_bits: 2,
        to_create: HashSet::new(),
        dictionary: HashMap::new(),
    };
    let mut dict_size: u32 = 3;
    let mut w: Vec<u16> = Vec::new();
    for c in input.encode_utf16() {
        if let std::collections::hash_map::Entry::Vacant(slot) = coder.dictionary.entry(vec![c]) {
            slot.insert(dict_size);
            dict_size += 1;
            coder.to_create.insert(c);
        }
        let mut wc = w.clone();
        wc.push(c);
        if coder.dictionary.contains_key(&wc) {
            w = wc;
        } else {
            coder.emit(&w);
            coder.dictionary.insert(wc, dict_size);
            dict_size += 1;
            w = vec![c];
        }
    }
    if !w.is_empty() {
        coder.emit(&w);
    }
    let num_bits = coder.num_bits;
    coder.writer.bits(2, num_bits);
    coder.writer.flush();
    let mut out = String::from_utf8(coder.writer.out).expect("the alphabet is ASCII");
    match out.len() % 4 {
        1 => out.push_str("==="),
        2 => out.push_str("=="),
        3 => out.push('='),
        _ => {}
    }
    out
}

struct Reader<'a> {
    values: &'a [u32],
    value: u32,
    position: u32,
    index: usize,
}

impl Reader<'_> {
    fn next_value(&self, index: usize) -> u32 {
        self.values.get(index).copied().unwrap_or(0)
    }

    fn bits(&mut self, count: u32) -> u32 {
        let mut bits = 0;
        for power in 0..count {
            let resb = self.value & self.position;
            self.position >>= 1;
            if self.position == 0 {
                self.position = 32;
                self.value = self.next_value(self.index);
                self.index += 1;
            }
            if resb > 0 {
                bits |= 1 << power;
            }
        }
        bits
    }
}

/// `None` for input that is not a valid stream (the library answers `null`).
pub fn decompress_from_base64(input: &str) -> Option<String> {
    if input.is_empty() {
        return None;
    }
    let values: Vec<u32> = input
        .bytes()
        .map(|b| {
            ALPHABET
                .iter()
                .position(|a| *a == b)
                .map_or(0, |i| i as u32)
        })
        .collect();
    let mut r = Reader {
        values: &values,
        value: values[0],
        position: 32,
        index: 1,
    };
    let mut dictionary: Vec<Vec<u16>> = vec![vec![], vec![], vec![]];
    let mut enlarge_in: u32 = 4;
    let mut num_bits: u32 = 3;

    let first = match r.bits(2) {
        0 => vec![r.bits(8) as u16],
        1 => vec![r.bits(16) as u16],
        2 => return Some(String::new()),
        _ => return None,
    };
    dictionary.push(first.clone());
    let mut w = first.clone();
    let mut result: Vec<u16> = first;
    loop {
        if r.index > values.len() {
            return Some(String::new());
        }
        let mut c = r.bits(num_bits) as usize;
        match c {
            0 | 1 => {
                let unit = r.bits(if c == 0 { 8 } else { 16 }) as u16;
                dictionary.push(vec![unit]);
                c = dictionary.len() - 1;
                enlarge_in -= 1;
            }
            2 => return Some(String::from_utf16_lossy(&result)),
            _ => {}
        }
        if enlarge_in == 0 {
            enlarge_in = 1 << num_bits;
            num_bits += 1;
        }
        let entry: Vec<u16> = if c < dictionary.len() {
            dictionary[c].clone()
        } else if c == dictionary.len() {
            let mut e = w.clone();
            e.push(*w.first()?);
            e
        } else {
            return None;
        };
        result.extend_from_slice(&entry);
        let mut next = w.clone();
        next.push(*entry.first()?);
        dictionary.push(next);
        enlarge_in -= 1;
        w = entry;
        if enlarge_in == 0 {
            enlarge_in = 1 << num_bits;
            num_bits += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Vectors {
        vectors: Vec<Vector>,
    }
    #[derive(serde::Deserialize)]
    struct Vector {
        text: String,
        base64: String,
    }

    #[test]
    fn it_matches_the_library_on_the_shared_vectors_both_ways() {
        let raw = include_str!("../../../shared/excalidraw-fixtures/lz-vectors.json");
        let v: Vectors = serde_json::from_str(raw).unwrap();
        assert!(v.vectors.len() >= 6);
        for (i, x) in v.vectors.iter().enumerate() {
            assert_eq!(
                compress_to_base64(&x.text),
                x.base64,
                "vector {i} compresses"
            );
            if !x.text.is_empty() {
                assert_eq!(
                    decompress_from_base64(&x.base64).as_deref(),
                    Some(x.text.as_str()),
                    "vector {i} decompresses"
                );
            }
        }
    }

    #[test]
    fn garbage_is_none_or_empty_never_a_panic() {
        assert_eq!(decompress_from_base64(""), None);
        for junk in ["!!!", "AAAA", "////", "A", "Zm9v", "N4Ig"] {
            let _ = decompress_from_base64(junk);
        }
    }
}
