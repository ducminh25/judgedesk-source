use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::cmp::Ordering;
use std::fmt;
use std::ops::{Add, Div, Mul, Sub};

const RADIX: u64 = 1_000_000_000;

/// Arbitrary-precision unsigned integer with zero-allocation inline `u64` representation
/// for values `<= u64::MAX` and normalized base-`10^9` little-endian limbs for larger values.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct BigUint {
    inline: u64,
    limbs: Vec<u32>,
}

impl BigUint {
    pub const ZERO: Self = Self {
        inline: 0,
        limbs: Vec::new(),
    };
    pub const ONE: Self = Self {
        inline: 1,
        limbs: Vec::new(),
    };

    pub const fn from_u64(v: u64) -> Self {
        Self {
            inline: v,
            limbs: Vec::new(),
        }
    }

    pub fn from_u128(mut v: u128) -> Self {
        if v <= u64::MAX as u128 {
            return Self::from_u64(v as u64);
        }
        let mut limbs = Vec::with_capacity(5);
        while v > 0 {
            limbs.push((v % RADIX as u128) as u32);
            v /= RADIX as u128;
        }
        Self::from_limbs(limbs)
    }

    fn from_limbs(mut limbs: Vec<u32>) -> Self {
        while limbs.last() == Some(&0) {
            limbs.pop();
        }
        if limbs.is_empty() {
            return Self::ZERO;
        }
        if limbs.len() <= 3 {
            let mut acc: u128 = 0;
            for &limb in limbs.iter().rev() {
                acc = acc * (RADIX as u128) + (limb as u128);
            }
            if acc <= u64::MAX as u128 {
                return Self::from_u64(acc as u64);
            }
        }
        Self { inline: 0, limbs }
    }

    fn to_limbs(&self) -> Vec<u32> {
        if !self.limbs.is_empty() {
            return self.limbs.clone();
        }
        let mut v = self.inline;
        if v == 0 {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(3);
        while v > 0 {
            out.push((v % RADIX) as u32);
            v /= RADIX;
        }
        out
    }

    pub fn is_zero(&self) -> bool {
        self.limbs.is_empty() && self.inline == 0
    }

    pub fn is_one(&self) -> bool {
        self.limbs.is_empty() && self.inline == 1
    }

    pub fn as_u64(&self) -> Option<u64> {
        if self.limbs.is_empty() {
            Some(self.inline)
        } else {
            None
        }
    }

    pub fn as_u128(&self) -> Option<u128> {
        if self.limbs.is_empty() {
            return Some(self.inline as u128);
        }
        if self.limbs.len() > 5 {
            return None;
        }
        let mut acc: u128 = 0;
        for &limb in self.limbs.iter().rev() {
            acc = acc.checked_mul(RADIX as u128)?.checked_add(limb as u128)?;
        }
        Some(acc)
    }

    pub fn parse_decimal_str(s: &str) -> Option<Self> {
        let trimmed = s.trim();
        if trimmed.is_empty() || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let stripped = trimmed.trim_start_matches('0');
        if stripped.is_empty() {
            return Some(Self::ZERO);
        }
        if stripped.len() <= 19 {
            if let Ok(v) = stripped.parse::<u64>() {
                return Some(Self::from_u64(v));
            }
        }
        let mut limbs = Vec::with_capacity(stripped.len().div_ceil(9));
        let mut end = stripped.len();
        while end > 0 {
            let start = end.saturating_sub(9);
            let chunk = &stripped[start..end];
            let limb = chunk.parse::<u32>().ok()?;
            limbs.push(limb);
            end = start;
        }
        Some(Self::from_limbs(limbs))
    }

    pub fn pow10(exp: usize) -> Self {
        if exp == 0 {
            return Self::ONE;
        }
        if exp <= 19 {
            if let Some(p) = 10u64.checked_pow(exp as u32) {
                return Self::from_u64(p);
            }
        }
        let full_limbs = exp / 9;
        let rem_exp = (exp % 9) as u32;
        let mut limbs = vec![0u32; full_limbs];
        limbs.push(10u32.pow(rem_exp));
        Self::from_limbs(limbs)
    }

    pub fn add_ref(&self, other: &Self) -> Self {
        if self.limbs.is_empty() && other.limbs.is_empty() {
            if let Some(sum) = self.inline.checked_add(other.inline) {
                return Self::from_u64(sum);
            }
            return Self::from_u128(self.inline as u128 + other.inline as u128);
        }
        let a = self.to_limbs();
        let b = other.to_limbs();
        let max_len = a.len().max(b.len());
        let mut out = Vec::with_capacity(max_len + 1);
        let mut carry: u64 = 0;
        for i in 0..max_len {
            let av = a.get(i).copied().unwrap_or(0) as u64;
            let bv = b.get(i).copied().unwrap_or(0) as u64;
            let sum = av + bv + carry;
            out.push((sum % RADIX) as u32);
            carry = sum / RADIX;
        }
        if carry > 0 {
            out.push(carry as u32);
        }
        Self::from_limbs(out)
    }

    /// Assumes `self >= other`.
    pub fn sub_ref(&self, other: &Self) -> Self {
        if self.limbs.is_empty() && other.limbs.is_empty() {
            return Self::from_u64(self.inline.saturating_sub(other.inline));
        }
        let a = self.to_limbs();
        let b = other.to_limbs();
        let mut out = Vec::with_capacity(a.len());
        let mut borrow: i64 = 0;
        for (i, &av_u32) in a.iter().enumerate() {
            let av = av_u32 as i64;
            let bv = b.get(i).copied().unwrap_or(0) as i64;
            let mut diff = av - bv - borrow;
            if diff < 0 {
                diff += RADIX as i64;
                borrow = 1;
            } else {
                borrow = 0;
            }
            out.push(diff as u32);
        }
        Self::from_limbs(out)
    }

    pub fn mul_u32(&self, rhs: u32) -> Self {
        if rhs == 0 || self.is_zero() {
            return Self::ZERO;
        }
        if rhs == 1 {
            return self.clone();
        }
        if self.limbs.is_empty() {
            return Self::from_u128((self.inline as u128) * (rhs as u128));
        }
        let a = &self.limbs;
        let mut out = Vec::with_capacity(a.len() + 1);
        let mut carry: u64 = 0;
        let mult = rhs as u64;
        for &limb in a {
            let prod = (limb as u64) * mult + carry;
            out.push((prod % RADIX) as u32);
            carry = prod / RADIX;
        }
        if carry > 0 {
            out.push(carry as u32);
        }
        Self::from_limbs(out)
    }

    pub fn mul_ref(&self, other: &Self) -> Self {
        if self.is_zero() || other.is_zero() {
            return Self::ZERO;
        }
        if self.limbs.is_empty() && other.limbs.is_empty() {
            return Self::from_u128((self.inline as u128) * (other.inline as u128));
        }
        let a = self.to_limbs();
        let b = other.to_limbs();
        let mut out = vec![0u32; a.len() + b.len()];
        for (i, &av) in a.iter().enumerate() {
            let mut carry: u64 = 0;
            let av_u64 = av as u64;
            for (j, &bv) in b.iter().enumerate() {
                let cur = out[i + j] as u64 + av_u64 * (bv as u64) + carry;
                out[i + j] = (cur % RADIX) as u32;
                carry = cur / RADIX;
            }
            let mut idx = i + b.len();
            while carry > 0 {
                let cur = out[idx] as u64 + carry;
                out[idx] = (cur % RADIX) as u32;
                carry = cur / RADIX;
                idx += 1;
            }
        }
        Self::from_limbs(out)
    }

    pub fn div_rem_u32(&self, divisor: u32) -> (Self, u32) {
        if divisor == 0 {
            return (Self::ZERO, 0);
        }
        if self.limbs.is_empty() {
            let d = divisor as u64;
            return (Self::from_u64(self.inline / d), (self.inline % d) as u32);
        }
        let mut quot = vec![0u32; self.limbs.len()];
        let mut rem: u64 = 0;
        let div_u64 = divisor as u64;
        for i in (0..self.limbs.len()).rev() {
            let cur = rem * RADIX + (self.limbs[i] as u64);
            quot[i] = (cur / div_u64) as u32;
            rem = cur % div_u64;
        }
        (Self::from_limbs(quot), rem as u32)
    }

    pub fn div_rem(&self, divisor: &Self) -> (Self, Self) {
        if divisor.is_zero() {
            return (Self::ZERO, Self::ZERO);
        }
        match self.cmp(divisor) {
            Ordering::Less => return (Self::ZERO, self.clone()),
            Ordering::Equal => return (Self::ONE, Self::ZERO),
            Ordering::Greater => {}
        }
        if let (Some(a), Some(b)) = (self.as_u128(), divisor.as_u128()) {
            return (Self::from_u128(a / b), Self::from_u128(a % b));
        }
        let a_limbs = self.to_limbs();
        let mut rem = Self::ZERO;
        let mut quot_limbs = vec![0u32; a_limbs.len()];

        for i in (0..a_limbs.len()).rev() {
            // rem = rem * RADIX + a_limbs[i]
            let mut rem_limbs = rem.to_limbs();
            if !rem_limbs.is_empty() || a_limbs[i] != 0 {
                rem_limbs.insert(0, a_limbs[i]);
            }
            rem = Self::from_limbs(rem_limbs);
            if rem < *divisor {
                quot_limbs[i] = 0;
                continue;
            }
            // Binary search quotient digit in 1..RADIX
            let mut low: u32 = 1;
            let mut high: u32 = (RADIX as u32) - 1;
            let mut best: u32 = 1;
            while low <= high {
                let mid = low + (high - low) / 2;
                let prod = divisor.mul_u32(mid);
                match prod.cmp(&rem) {
                    Ordering::Less => {
                        best = mid;
                        low = mid + 1;
                    }
                    Ordering::Equal => {
                        best = mid;
                        break;
                    }
                    Ordering::Greater => {
                        high = mid - 1;
                    }
                }
            }
            quot_limbs[i] = best;
            rem = rem.sub_ref(&divisor.mul_u32(best));
        }

        (Self::from_limbs(quot_limbs), rem)
    }

    pub fn gcd(mut a: Self, mut b: Self) -> Self {
        while !b.is_zero() {
            if let (Some(au), Some(bu)) = (a.as_u128(), b.as_u128()) {
                let mut x = au;
                let mut y = bu;
                while y != 0 {
                    let t = y;
                    y = x % y;
                    x = t;
                }
                return Self::from_u128(x);
            }
            let (_, rem) = a.div_rem(&b);
            a = b;
            b = rem;
        }
        a
    }

    pub fn to_f64(&self) -> f64 {
        if self.limbs.is_empty() {
            return self.inline as f64;
        }
        let mut acc = 0.0f64;
        for &limb in self.limbs.iter().rev() {
            acc = acc * (RADIX as f64) + (limb as f64);
        }
        acc
    }
}

impl Ord for BigUint {
    fn cmp(&self, other: &Self) -> Ordering {
        if self.limbs.is_empty() && other.limbs.is_empty() {
            return self.inline.cmp(&other.inline);
        }
        let a = self.to_limbs();
        let b = other.to_limbs();
        match a.len().cmp(&b.len()) {
            Ordering::Equal => {
                for i in (0..a.len()).rev() {
                    let c = a[i].cmp(&b[i]);
                    if c != Ordering::Equal {
                        return c;
                    }
                }
                Ordering::Equal
            }
            ord => ord,
        }
    }
}

impl PartialOrd for BigUint {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl fmt::Display for BigUint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.limbs.is_empty() {
            return write!(f, "{}", self.inline);
        }
        let last_idx = self.limbs.len() - 1;
        write!(f, "{}", self.limbs[last_idx])?;
        for i in (0..last_idx).rev() {
            write!(f, "{:09}", self.limbs[i])?;
        }
        Ok(())
    }
}

/// Arbitrary-precision signed integer (`sign` is `false` for zero/positive, `true` for negative).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct BigInt {
    neg: bool,
    mag: BigUint,
}

impl BigInt {
    pub const ZERO: Self = Self {
        neg: false,
        mag: BigUint::ZERO,
    };
    pub const ONE: Self = Self {
        neg: false,
        mag: BigUint::ONE,
    };

    pub fn from_parts(neg: bool, mag: BigUint) -> Self {
        if mag.is_zero() {
            Self::ZERO
        } else {
            Self { neg, mag }
        }
    }

    pub const fn from_i64(v: i64) -> Self {
        if v == 0 {
            Self::ZERO
        } else if v < 0 {
            Self {
                neg: true,
                mag: BigUint::from_u64(v.unsigned_abs()),
            }
        } else {
            Self {
                neg: false,
                mag: BigUint::from_u64(v as u64),
            }
        }
    }

    pub fn is_zero(&self) -> bool {
        self.mag.is_zero()
    }

    pub fn is_negative(&self) -> bool {
        self.neg && !self.mag.is_zero()
    }

    pub fn abs_uint(&self) -> &BigUint {
        &self.mag
    }

    pub fn negated(&self) -> Self {
        if self.is_zero() {
            Self::ZERO
        } else {
            Self {
                neg: !self.neg,
                mag: self.mag.clone(),
            }
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        let u = self.mag.as_u64()?;
        if self.neg {
            if u == (i64::MAX as u64) + 1 {
                Some(i64::MIN)
            } else if u <= i64::MAX as u64 {
                Some(-(u as i64))
            } else {
                None
            }
        } else if u <= i64::MAX as u64 {
            Some(u as i64)
        } else {
            None
        }
    }

    pub fn as_safe_js_i64(&self) -> Option<i64> {
        const MAX_SAFE_JS_INT: i64 = 9_007_199_254_740_991;
        self.as_i64()
            .filter(|&v| (-MAX_SAFE_JS_INT..=MAX_SAFE_JS_INT).contains(&v))
    }

    pub fn add_ref(&self, other: &Self) -> Self {
        if self.neg == other.neg {
            Self::from_parts(self.neg, self.mag.add_ref(&other.mag))
        } else {
            match self.mag.cmp(&other.mag) {
                Ordering::Equal => Self::ZERO,
                Ordering::Greater => Self::from_parts(self.neg, self.mag.sub_ref(&other.mag)),
                Ordering::Less => Self::from_parts(other.neg, other.mag.sub_ref(&self.mag)),
            }
        }
    }

    pub fn sub_ref(&self, other: &Self) -> Self {
        self.add_ref(&other.negated())
    }

    pub fn mul_ref(&self, other: &Self) -> Self {
        Self::from_parts(self.neg ^ other.neg, self.mag.mul_ref(&other.mag))
    }

    pub fn to_f64(&self) -> f64 {
        let v = self.mag.to_f64();
        if self.neg {
            -v
        } else {
            v
        }
    }
}

impl Ord for BigInt {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self.is_negative(), other.is_negative()) {
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (true, true) => other.mag.cmp(&self.mag),
            (false, false) => self.mag.cmp(&other.mag),
        }
    }
}

impl PartialOrd for BigInt {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl From<i64> for BigInt {
    fn from(v: i64) -> Self {
        Self::from_i64(v)
    }
}

impl PartialEq<i64> for BigInt {
    fn eq(&self, other: &i64) -> bool {
        self.as_i64() == Some(*other)
    }
}

impl fmt::Display for BigInt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.is_negative() {
            write!(f, "-{}", self.mag)
        } else {
            write!(f, "{}", self.mag)
        }
    }
}

impl Serialize for BigInt {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if let Some(i) = self.as_safe_js_i64() {
            serializer.serialize_i64(i)
        } else {
            serializer.serialize_str(&self.to_string())
        }
    }
}

/// Greatest Common Divisor using Euclid's algorithm (i64 compatibility helper).
pub fn gcd(a: i64, b: i64) -> i64 {
    let mut x = a.unsigned_abs();
    let mut y = b.unsigned_abs();
    while y > 0 {
        let t = y;
        y = x % y;
        x = t;
    }
    x.min(i64::MAX as u64) as i64
}

/// Exact arbitrary-precision Rational Number representation avoiding IEEE-754 floating point drift.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Rational {
    pub n: BigInt,
    pub d: BigInt,
}

pub fn compare_rational(a: &Rational, b: &Rational) -> Ordering {
    a.n.mul_ref(&b.d).cmp(&b.n.mul_ref(&a.d))
}

impl Ord for Rational {
    fn cmp(&self, other: &Self) -> Ordering {
        compare_rational(self, other)
    }
}

impl PartialOrd for Rational {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Default for Rational {
    fn default() -> Self {
        Self::ZERO
    }
}

impl Rational {
    pub const ZERO: Self = Self {
        n: BigInt::ZERO,
        d: BigInt::ONE,
    };
    pub const ONE: Self = Self {
        n: BigInt::ONE,
        d: BigInt::ONE,
    };

    pub fn new(n: i64, d: i64) -> Self {
        Self::from_bigints(BigInt::from_i64(n), BigInt::from_i64(d))
    }

    pub fn from_bigints(n: BigInt, d: BigInt) -> Self {
        if d.is_zero() || n.is_zero() {
            return Self::ZERO;
        }
        let neg = n.is_negative() ^ d.is_negative();
        let g = BigUint::gcd(n.abs_uint().clone(), d.abs_uint().clone());
        let (red_n, _) = n.abs_uint().div_rem(&g);
        let (red_d, _) = d.abs_uint().div_rem(&g);
        Self {
            n: BigInt::from_parts(neg, red_n),
            d: BigInt::from_parts(false, red_d),
        }
    }

    pub fn from_integer(n: i64) -> Self {
        Self::new(n, 1)
    }

    pub fn to_f64(&self) -> f64 {
        if self.d.is_zero() || self.n.is_zero() {
            return 0.0;
        }
        if let (Some(nu), Some(du)) = (self.n.abs_uint().as_u128(), self.d.abs_uint().as_u128()) {
            let ratio = (nu as f64) / (du as f64);
            return if self.n.is_negative() { -ratio } else { ratio };
        }
        // Scale to 10^15 using exact BigUint division so huge numerators/denominators don't overflow f64
        let scale = BigUint::pow10(15);
        let scaled_num = self.n.abs_uint().mul_ref(&scale);
        let (q, _) = scaled_num.div_rem(self.d.abs_uint());
        let ratio = q.to_f64() / 1e15;
        if self.n.is_negative() {
            -ratio
        } else {
            ratio
        }
    }

    pub fn is_zero(&self) -> bool {
        self.n.is_zero()
    }

    pub fn is_integer(&self) -> bool {
        self.d.abs_uint().is_one()
    }
}

/// Convert an f64 to Rational using continued fraction expansion.
pub fn float_to_rational(x: f64, max_den: i64) -> Rational {
    if !x.is_finite() {
        return Rational::ZERO;
    }
    if x.fract() == 0.0 && x.abs() <= (i64::MAX as f64) {
        return Rational::new(x as i64, 1);
    }
    let sign = if x < 0.0 { -1 } else { 1 };
    let val = x.abs();
    let mut h1: i64 = 1;
    let mut h2: i64 = 0;
    let mut k1: i64 = 0;
    let mut k2: i64 = 1;
    let mut b = val;

    loop {
        let a = b.floor() as i64;
        let aux_h = h1;
        h1 = a.saturating_mul(h1).saturating_add(h2);
        h2 = aux_h;
        let aux_k = k1;
        k1 = a.saturating_mul(k1).saturating_add(k2);
        k2 = aux_k;

        let diff = b - a as f64;
        if diff.abs() < 1e-15 || k1 == 0 {
            break;
        }
        b = 1.0 / diff;

        if (val - (h1 as f64 / k1 as f64)).abs() <= 1e-9 || k1 > max_den || !b.is_finite() {
            break;
        }
    }

    Rational::new(sign * h1, k1)
}

fn parse_exact_decimal_or_int_str(raw: &str) -> Option<Rational> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (neg, unsigned_str) = if let Some(rest) = trimmed.strip_prefix('-') {
        (true, rest.trim())
    } else if let Some(rest) = trimmed.strip_prefix('+') {
        (false, rest.trim())
    } else {
        (false, trimmed)
    };
    if unsigned_str.is_empty() {
        return None;
    }

    // Handle optional scientific notation e/E
    let (mantissa_str, exp_offset): (&str, i64) =
        if let Some((m, e)) = unsigned_str.split_once(['e', 'E']) {
            let exp_val = e.trim().parse::<i64>().ok()?;
            if exp_val.abs() > 10_000 {
                return None;
            }
            (m.trim(), exp_val)
        } else {
            (unsigned_str, 0)
        };

    let (int_part, frac_part) = if let Some((i, f)) = mantissa_str.split_once('.') {
        (i, f)
    } else {
        (mantissa_str, "")
    };

    if int_part.is_empty() && frac_part.is_empty() {
        return None;
    }
    if !int_part.bytes().all(|b| b.is_ascii_digit())
        || !frac_part.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }

    let combined_digits = format!("{int_part}{frac_part}");
    let mag = BigUint::parse_decimal_str(&combined_digits)?;
    if mag.is_zero() {
        return Some(Rational::ZERO);
    }

    let total_shift = exp_offset - (frac_part.len() as i64);
    if total_shift >= 0 {
        let scale = BigUint::pow10(total_shift as usize);
        let num = BigInt::from_parts(neg, mag.mul_ref(&scale));
        Some(Rational::from_bigints(num, BigInt::ONE))
    } else {
        let den_pow = (-total_shift) as usize;
        let den = BigInt::from_parts(false, BigUint::pow10(den_pow));
        let num = BigInt::from_parts(neg, mag);
        Some(Rational::from_bigints(num, den))
    }
}

/// Parse any supported JSON/string/numeric representation into a strict Rational.
pub fn parse_rational<T: AsRef<str>>(input: T) -> Rational {
    let raw = input.as_ref().trim();
    if raw.is_empty() {
        return Rational::ZERO;
    }

    if let Some((num_str, den_str)) = raw.split_once('/') {
        let num = parse_rational(num_str);
        let den = parse_rational(den_str);
        if !den.is_zero() {
            return divide_rational(num, den);
        }
        return Rational::ZERO;
    }

    if let Some(exact) = parse_exact_decimal_or_int_str(raw) {
        return exact;
    }

    if let Ok(num) = raw.parse::<f64>() {
        return parse_rational_f64(num);
    }

    Rational::ZERO
}

/// Parse f64 into Rational with snapping for IEEE-754 precision artifacts.
pub fn parse_rational_f64(input: f64) -> Rational {
    if !input.is_finite() {
        return Rational::ZERO;
    }
    let nearest_int = input.round();
    if (input - nearest_int).abs() < 1e-9 && nearest_int.abs() <= (i64::MAX as f64) {
        return Rational::new(nearest_int as i64, 1);
    }
    let rounded6 = (input * 1e6).round() / 1e6;
    if (input - rounded6).abs() < 1e-8 {
        return float_to_rational(rounded6, 100_000);
    }
    float_to_rational(input, 100_000)
}

/// Parse from serde_json::Value
pub fn parse_rational_value(value: &serde_json::Value) -> Rational {
    match value {
        serde_json::Value::Null => Rational::ZERO,
        serde_json::Value::Number(num) => {
            if let Some(i) = num.as_i64() {
                Rational::new(i, 1)
            } else if let Some(u) = num.as_u64() {
                Rational::from_bigints(BigInt::from_parts(false, BigUint::from_u64(u)), BigInt::ONE)
            } else if let Some(f) = num.as_f64() {
                parse_rational_f64(f)
            } else {
                Rational::ZERO
            }
        }
        serde_json::Value::String(s) => parse_rational(s),
        serde_json::Value::Object(map) => {
            if let (Some(n_val), Some(d_val)) = (map.get("n"), map.get("d")) {
                let n = parse_rational_value(n_val);
                let d = parse_rational_value(d_val);
                if d.is_zero() {
                    Rational::ZERO
                } else {
                    divide_rational(n, d)
                }
            } else {
                Rational::ZERO
            }
        }
        _ => Rational::ZERO,
    }
}

pub fn add_rational(a: Rational, b: Rational) -> Rational {
    let num = a.n.mul_ref(&b.d).add_ref(&b.n.mul_ref(&a.d));
    let den = a.d.mul_ref(&b.d);
    Rational::from_bigints(num, den)
}

pub fn subtract_rational(a: Rational, b: Rational) -> Rational {
    let num = a.n.mul_ref(&b.d).sub_ref(&b.n.mul_ref(&a.d));
    let den = a.d.mul_ref(&b.d);
    Rational::from_bigints(num, den)
}

pub fn multiply_rational(a: Rational, b: Rational) -> Rational {
    Rational::from_bigints(a.n.mul_ref(&b.n), a.d.mul_ref(&b.d))
}

pub fn divide_rational(a: Rational, b: Rational) -> Rational {
    if b.is_zero() {
        return Rational::ZERO;
    }
    Rational::from_bigints(a.n.mul_ref(&b.d), a.d.mul_ref(&b.n))
}

/// Checks if a positive integer denominator has only prime factors 2 and 5,
/// returning `Some(max(count_2, count_5))` (the exact number of decimal places) if so.
fn terminating_decimal_places(denominator: &BigUint) -> Option<usize> {
    if denominator.is_zero() {
        return None;
    }
    let mut d = denominator.clone();
    let mut twos = 0usize;
    let mut fives = 0usize;
    loop {
        let (q, rem) = d.div_rem_u32(2);
        if rem == 0 {
            d = q;
            twos += 1;
        } else {
            break;
        }
    }
    loop {
        let (q, rem) = d.div_rem_u32(5);
        if rem == 0 {
            d = q;
            fives += 1;
        } else {
            break;
        }
    }
    if d.is_one() {
        Some(twos.max(fives))
    } else {
        None
    }
}

pub fn is_terminating_decimal(denominator: i64) -> bool {
    if denominator <= 0 {
        return false;
    }
    terminating_decimal_places(&BigUint::from_u64(denominator as u64)).is_some()
}

fn format_exact_terminating(r: &Rational, max_decimals: usize) -> Option<String> {
    let places = terminating_decimal_places(r.d.abs_uint())?;
    if places > max_decimals {
        return None;
    }
    let scale = BigUint::pow10(places);
    let scaled_mag = r.n.abs_uint().mul_ref(&scale);
    let (exact_scaled, rem) = scaled_mag.div_rem(r.d.abs_uint());
    if !rem.is_zero() {
        return None;
    }
    let (int_part, frac_part) = exact_scaled.div_rem(&scale);
    let sign_prefix = if r.n.is_negative() { "-" } else { "" };
    if frac_part.is_zero() || places == 0 {
        return Some(format!("{sign_prefix}{int_part}"));
    }
    let frac_raw = frac_part.to_string();
    let pad_len = places.saturating_sub(frac_raw.len());
    let frac_padded = format!("{}{frac_raw}", "0".repeat(pad_len));
    let frac_trimmed = frac_padded.trim_end_matches('0');
    Some(format!("{sign_prefix}{int_part}.{frac_trimmed}"))
}

pub fn format_rational(r: Rational, max_decimals: usize) -> String {
    if r.is_zero() {
        return "0".to_string();
    }
    if r.is_integer() {
        return r.n.to_string();
    }
    if let Some(dec_str) = format_exact_terminating(&r, max_decimals) {
        return dec_str;
    }
    format!("{}/{}", r.n, r.d)
}

/// Formats a `Rational` as a fixed-point decimal string with `decimal_places` digits
/// after the decimal point, using exact `BigUint` half-up rounding (presentation only).
pub fn format_rational_decimal(r: &Rational, decimal_places: usize) -> String {
    if r.d.is_zero() || r.is_zero() {
        if decimal_places == 0 {
            return "0".to_string();
        }
        return format!("0.{}", "0".repeat(decimal_places));
    }
    let scale = BigUint::pow10(decimal_places);
    let scaled_num = r.n.abs_uint().mul_ref(&scale);
    let (mut q, rem) = scaled_num.div_rem(r.d.abs_uint());
    let twice_rem = rem.mul_u32(2);
    let round_up = if r.n.is_negative() {
        twice_rem > *r.d.abs_uint()
    } else {
        twice_rem >= *r.d.abs_uint()
    };
    if round_up {
        q = q.add_ref(&BigUint::ONE);
    }
    if q.is_zero() {
        if decimal_places == 0 {
            return "0".to_string();
        }
        return format!("0.{}", "0".repeat(decimal_places));
    }
    let sign = if r.n.is_negative() { "-" } else { "" };
    if decimal_places == 0 {
        return format!("{sign}{q}");
    }
    let (whole, frac) = q.div_rem(&scale);
    let frac_raw = frac.to_string();
    let pad_len = decimal_places.saturating_sub(frac_raw.len());
    let frac_padded = format!("{}{frac_raw}", "0".repeat(pad_len));
    format!("{sign}{whole}.{frac_padded}")
}

pub fn format_score(value: &serde_json::Value, max_decimals: usize) -> String {
    if value.is_null() {
        return "-".to_string();
    }
    if let serde_json::Value::String(s) = value {
        if s.trim().is_empty() {
            return "-".to_string();
        }
    }
    let r = parse_rational_value(value);
    format_rational(r, max_decimals)
}

pub fn to_canonical_point_value(r: Rational) -> serde_json::Value {
    if r.is_integer() {
        if let Some(i) = r.n.as_safe_js_i64() {
            return serde_json::json!(i);
        }
        return serde_json::json!(r.n.to_string());
    }
    if let Some(dec_str) = format_exact_terminating(&r, 4) {
        if let Ok(num) = dec_str.parse::<f64>() {
            if num.is_finite() && num.to_string() == dec_str {
                return serde_json::json!(num);
            }
        }
        return serde_json::json!(dec_str);
    }
    serde_json::json!(format!("{}/{}", r.n, r.d))
}

impl Add for Rational {
    type Output = Self;
    fn add(self, rhs: Self) -> Self::Output {
        add_rational(self, rhs)
    }
}

impl Sub for Rational {
    type Output = Self;
    fn sub(self, rhs: Self) -> Self::Output {
        subtract_rational(self, rhs)
    }
}

impl Mul for Rational {
    type Output = Self;
    fn mul(self, rhs: Self) -> Self::Output {
        multiply_rational(self, rhs)
    }
}

impl Div for Rational {
    type Output = Self;
    fn div(self, rhs: Self) -> Self::Output {
        divide_rational(self, rhs)
    }
}

impl fmt::Display for Rational {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", format_rational(self.clone(), 2))
    }
}

impl Serialize for Rational {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("Rational", 2)?;
        state.serialize_field("n", &self.n)?;
        state.serialize_field("d", &self.d)?;
        state.end()
    }
}

impl<'de> Deserialize<'de> for Rational {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let val = serde_json::Value::deserialize(deserializer)?;
        Ok(parse_rational_value(&val))
    }
}
