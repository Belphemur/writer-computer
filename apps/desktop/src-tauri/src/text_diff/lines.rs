//! A small line diff (Myers, O(ND)). No dependency: the repo ships no diff crate. Pure and
//! Tauri-free; the one core of the agent's "Changes" card (`agent/changes.rs`), the lint engine's
//! edits (`lint/`) and the Git history (`git/`). It diffs any slice of `&str`, so lines, blocks
//! and words all go through it.
//!
//! The common prefix and suffix are trimmed first (most agent edits touch a small middle), and a
//! file pair that needs more than [`MAX_EDITS`] edits falls back to "everything in the middle
//! removed, then everything added": still a correct diff, only not minimal, and it bounds the
//! time and the memory of the trace.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edit {
    /// Index into `a` and into `b`.
    Equal(usize, usize),
    /// Index into `a`.
    Del(usize),
    /// Index into `b`.
    Add(usize),
}

pub const MAX_EDITS: usize = 1500;

/// Split text into lines: `\n` separated, a final newline does not start an empty line. A `\r`
/// stays on its line (a CRLF file differs from an LF file on every line).
pub fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let body = text.strip_suffix('\n').unwrap_or(text);
    body.split('\n').collect()
}

pub fn diff_lines(a: &[&str], b: &[&str]) -> Vec<Edit> {
    let mut prefix = 0;
    while prefix < a.len() && prefix < b.len() && a[prefix] == b[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < a.len() - prefix
        && suffix < b.len() - prefix
        && a[a.len() - 1 - suffix] == b[b.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let (ma, mb) = (&a[prefix..a.len() - suffix], &b[prefix..b.len() - suffix]);
    let mut out: Vec<Edit> = (0..prefix).map(|i| Edit::Equal(i, i)).collect();
    let middle = myers(ma, mb).unwrap_or_else(|| {
        (0..ma.len())
            .map(Edit::Del)
            .chain((0..mb.len()).map(Edit::Add))
            .collect()
    });
    out.extend(middle.into_iter().map(|e| match e {
        Edit::Equal(i, j) => Edit::Equal(i + prefix, j + prefix),
        Edit::Del(i) => Edit::Del(i + prefix),
        Edit::Add(j) => Edit::Add(j + prefix),
    }));
    let (la, lb) = (a.len() - suffix, b.len() - suffix);
    out.extend((0..suffix).map(|i| Edit::Equal(la + i, lb + i)));
    out
}

/// `(added, removed)` of an edit script.
pub fn counts(edits: &[Edit]) -> (u32, u32) {
    edits.iter().fold((0, 0), |(a, d), e| match e {
        Edit::Add(_) => (a + 1, d),
        Edit::Del(_) => (a, d + 1),
        Edit::Equal(..) => (a, d),
    })
}

fn myers(a: &[&str], b: &[&str]) -> Option<Vec<Edit>> {
    let (n, m) = (a.len() as isize, b.len() as isize);
    if n == 0 && m == 0 {
        return Some(Vec::new());
    }
    let lim = ((n + m) as usize).min(MAX_EDITS);
    let off = lim as isize + 1;
    let idx = |k: isize| (off + k) as usize;
    let mut v = vec![0isize; 2 * lim + 3];
    let mut trace: Vec<Vec<isize>> = Vec::new();
    let mut found = None;
    'outer: for d in 0..=lim as isize {
        trace.push(v.clone());
        let mut k = -d;
        while k <= d {
            let mut x = if k == -d || (k != d && v[idx(k - 1)] < v[idx(k + 1)]) {
                v[idx(k + 1)]
            } else {
                v[idx(k - 1)] + 1
            };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[idx(k)] = x;
            if x >= n && y >= m {
                found = Some(d);
                break 'outer;
            }
            k += 2;
        }
    }
    let d_total = found?;
    let (mut x, mut y) = (n, m);
    let mut out = Vec::new();
    for d in (1..=d_total).rev() {
        let v = &trace[d as usize];
        let k = x - y;
        let prev_k = if k == -d || (k != d && v[idx(k - 1)] < v[idx(k + 1)]) {
            k + 1
        } else {
            k - 1
        };
        let prev_x = v[idx(prev_k)];
        let prev_y = prev_x - prev_k;
        while x > prev_x && y > prev_y {
            x -= 1;
            y -= 1;
            out.push(Edit::Equal(x as usize, y as usize));
        }
        if x == prev_x {
            y -= 1;
            out.push(Edit::Add(y as usize));
        } else {
            x -= 1;
            out.push(Edit::Del(x as usize));
        }
    }
    while x > 0 && y > 0 {
        x -= 1;
        y -= 1;
        out.push(Edit::Equal(x as usize, y as usize));
    }
    out.reverse();
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(a: &[&str], b: &[&str], edits: &[Edit]) -> Vec<String> {
        // replaying the script over `a` must give `b`
        let mut out = Vec::new();
        for e in edits {
            match e {
                Edit::Equal(i, j) => {
                    assert_eq!(a[*i], b[*j]);
                    out.push(a[*i].to_string());
                }
                Edit::Del(_) => {}
                Edit::Add(j) => out.push(b[*j].to_string()),
            }
        }
        out
    }

    fn check(a: &str, b: &str) -> (u32, u32) {
        let (la, lb) = (split_lines(a), split_lines(b));
        let edits = diff_lines(&la, &lb);
        assert_eq!(apply(&la, &lb, &edits), lb);
        counts(&edits)
    }

    #[test]
    fn counts_for_simple_cases() {
        assert_eq!(check("a\nb\nc\n", "a\nb\nc\n"), (0, 0));
        assert_eq!(check("a\nb\nc\n", "a\nX\nc\n"), (1, 1));
        assert_eq!(check("", "a\nb\n"), (2, 0));
        assert_eq!(check("a\nb\n", ""), (0, 2));
        assert_eq!(check("a\nb\nc\nd\n", "b\nc\n"), (0, 2));
        assert_eq!(check("a\nb\n", "a\nb\nc\nd\n"), (2, 0));
    }

    #[test]
    fn interleaved_edits_are_minimal() {
        assert_eq!(check("1\n2\n3\n4\n5\n6\n", "1\nx\n3\n4\ny\n6\n"), (2, 2));
        // the classic Myers example: ABCABBA -> CBABAC needs 5 edits
        let (add, del) = check("a\nb\nc\na\nb\nb\na\n", "c\nb\na\nb\na\nc\n");
        assert_eq!(add + del, 5);
    }

    #[test]
    fn crlf_lines_differ_from_lf_lines() {
        assert_eq!(check("a\r\nb\r\n", "a\nb\n"), (2, 2));
        assert_eq!(check("a\r\nb\r\n", "a\r\nB\r\n"), (1, 1));
    }

    #[test]
    fn final_newline_does_not_add_a_line() {
        assert_eq!(split_lines("a\nb\n"), vec!["a", "b"]);
        assert_eq!(split_lines("a\nb"), vec!["a", "b"]);
        assert_eq!(split_lines("a\n\n"), vec!["a", ""]);
        assert!(split_lines("").is_empty());
    }

    #[test]
    fn huge_edit_distance_falls_back_to_replace_all() {
        let a: Vec<String> = (0..2000).map(|i| format!("a{i}")).collect();
        let b: Vec<String> = (0..2000).map(|i| format!("b{i}")).collect();
        let (ra, rb): (Vec<&str>, Vec<&str>) = (
            a.iter().map(String::as_str).collect(),
            b.iter().map(String::as_str).collect(),
        );
        let edits = diff_lines(&ra, &rb);
        assert_eq!(counts(&edits), (2000, 2000));
        assert_eq!(apply(&ra, &rb, &edits), rb);
    }
}
