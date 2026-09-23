use std::cmp::Ordering;

fn char_weight(c: char) -> (u8, u32) {
    match c {
        '_' => (0, 0),
        '-' => (0, 1),
        '.' => (0, 2),
        c if c.is_ascii_punctuation() => (0, 10 + c as u32),
        c if c.is_alphabetic() => {
            let lower = c.to_lowercase().next().unwrap_or(c);
            (2, lower as u32)
        }
        c => (1, c as u32),
    }
}

/// Compares two strings using natural order (numeric aware, case-insensitive, Unicode collation order for separators)
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut a_chars = a.chars().peekable();
    let mut b_chars = b.chars().peekable();

    while a_chars.peek().is_some() || b_chars.peek().is_some() {
        match (a_chars.peek(), b_chars.peek()) {
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (None, None) => return Ordering::Equal,
            (Some(ca), Some(cb)) if ca.is_ascii_digit() && cb.is_ascii_digit() => {
                let mut num_a: u64 = 0;
                while let Some(c) = a_chars.peek() {
                    if let Some(d) = c.to_digit(10) {
                        num_a = num_a.saturating_mul(10).saturating_add(d as u64);
                        a_chars.next();
                    } else {
                        break;
                    }
                }
                let mut num_b: u64 = 0;
                while let Some(c) = b_chars.peek() {
                    if let Some(d) = c.to_digit(10) {
                        num_b = num_b.saturating_mul(10).saturating_add(d as u64);
                        b_chars.next();
                    } else {
                        break;
                    }
                }
                match num_a.cmp(&num_b) {
                    Ordering::Equal => continue,
                    non_eq => return non_eq,
                }
            }
            (Some(&ca), Some(&cb)) => {
                let weight_a = char_weight(ca);
                let weight_b = char_weight(cb);
                match weight_a.cmp(&weight_b) {
                    Ordering::Equal => {
                        a_chars.next();
                        b_chars.next();
                    }
                    non_eq => return non_eq,
                }
            }
        }
    }
    Ordering::Equal
}
