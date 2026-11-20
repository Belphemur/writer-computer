//! The one place that converts between the three position systems a lint result meets: rumdl's
//! byte offsets and 1-based character columns, the Obsidian scanner's `char` offsets, and the
//! editor's UTF-16 offsets.

pub struct Index {
    /// Byte offset of each `char`, plus the length of the text at the end.
    byte_at_char: Vec<usize>,
    /// UTF-16 offset of each `char`, plus the length of the text at the end.
    utf16_at_char: Vec<u32>,
    /// `char` offset of the first character of each line.
    line_starts: Vec<usize>,
}

impl Index {
    pub fn new(text: &str) -> Self {
        let mut byte_at_char = Vec::with_capacity(text.len() + 1);
        let mut utf16_at_char = Vec::with_capacity(text.len() + 1);
        let mut line_starts = vec![0];
        let mut u = 0u32;
        for (i, (b, c)) in text.char_indices().enumerate() {
            byte_at_char.push(b);
            utf16_at_char.push(u);
            u += c.len_utf16() as u32;
            if c == '\n' {
                line_starts.push(i + 1);
            }
        }
        byte_at_char.push(text.len());
        utf16_at_char.push(u);
        Self {
            byte_at_char,
            utf16_at_char,
            line_starts,
        }
    }

    pub fn chars(&self) -> usize {
        self.byte_at_char.len() - 1
    }

    /// The `char` offset of a byte offset (a boundary; one inside a character rounds down).
    pub fn char_of_byte(&self, byte: usize) -> usize {
        self.byte_at_char
            .partition_point(|b| *b <= byte)
            .saturating_sub(1)
    }

    /// The `char` offset of a 1-based line and character column, clamped to the text.
    pub fn char_of_line_col(&self, line: usize, column: usize) -> usize {
        let start = self
            .line_starts
            .get(line.saturating_sub(1))
            .copied()
            .unwrap_or_else(|| self.chars());
        (start + column.saturating_sub(1)).min(self.chars())
    }

    pub fn utf16_of_char(&self, char_offset: usize) -> u32 {
        self.utf16_at_char[char_offset.min(self.chars())]
    }

    pub fn utf16_of_byte(&self, byte: usize) -> u32 {
        self.utf16_of_char(self.char_of_byte(byte))
    }

    /// 1-based line and character column of a `char` offset.
    pub fn line_col(&self, char_offset: usize) -> (u32, u32) {
        let line = self.line_starts.partition_point(|s| *s <= char_offset) - 1;
        (
            line as u32 + 1,
            (char_offset - self.line_starts[line]) as u32 + 1,
        )
    }
}
