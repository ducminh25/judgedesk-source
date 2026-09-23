use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::ops::{Add, Div, Mul, Sub};

/// Greatest Common Divisor using Euclid's algorithm
pub fn gcd(a: i64, b: i64) -> i64 {
    let mut x = a.abs();
    let mut y = b.abs();
    while y > 0 {
        let t = y;
        y = x % y;
        x = t;
    }
    x
}

/// Exact Rational Number representation avoiding IEEE-754 floating point drift.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Rational {
    pub n: i64,
    pub d: i64,
}

impl Default for Rational {
    fn default() -> Self {
        Self::new(0, 1)
    }
}

impl Rational {
    pub const ZERO: Self = Self { n: 0, d: 1 };
    pub const ONE: Self = Self { n: 1, d: 1 };

    pub fn new(n: i64, d: i64) -> Self {
        if d == 0 {
            return Self::ZERO;
        }
        let mut num = n;
        let mut den = d;
        if den < 0 {
            num = -num;
            den = -den;
        }
        let divisor = gcd(num, den).max(1);
        Self {
            n: num / divisor,
            d: den / divisor,
        }
    }

    pub fn from_integer(n: i64) -> Self {
        Self::new(n, 1)
    }

    pub fn to_f64(self) -> f64 {
        if self.d == 0 {
            0.0
        } else {
            self.n as f64 / self.d as f64
        }
    }

    pub fn is_zero(self) -> bool {
        self.n == 0
    }

    pub fn is_integer(self) -> bool {
        self.d == 1
    }
}

/// Convert an f64 to Rational using continued fraction expansion.
pub fn float_to_rational(x: f64, max_den: i64) -> Rational {
    if !x.is_finite() {
        return Rational::ZERO;
    }
    if x.fract() == 0.0 {
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

/// Parse any supported JSON/string/numeric representation into a strict Rational.
pub fn parse_rational<T: AsRef<str>>(input: T) -> Rational {
    let raw = input.as_ref().trim();
    if raw.is_empty() {
        return Rational::ZERO;
    }

    if let Some((num_str, den_str)) = raw.split_once('/') {
        if let (Ok(num), Ok(den)) = (num_str.trim().parse::<f64>(), den_str.trim().parse::<f64>()) {
            if den != 0.0 {
                return divide_rational(parse_rational_f64(num), parse_rational_f64(den));
            }
        }
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
    if (input - nearest_int).abs() < 1e-9 {
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
            } else if let Some(f) = num.as_f64() {
                parse_rational_f64(f)
            } else {
                Rational::ZERO
            }
        }
        serde_json::Value::String(s) => parse_rational(s),
        serde_json::Value::Object(map) => {
            if let (Some(n_val), Some(d_val)) = (map.get("n"), map.get("d")) {
                let n = n_val.as_i64().unwrap_or(0);
                let d = d_val.as_i64().unwrap_or(1);
                Rational::new(n, d)
            } else {
                Rational::ZERO
            }
        }
        _ => Rational::ZERO,
    }
}

pub fn add_rational(a: Rational, b: Rational) -> Rational {
    Rational::new(
        a.n.saturating_mul(b.d)
            .saturating_add(b.n.saturating_mul(a.d)),
        a.d.saturating_mul(b.d),
    )
}

pub fn subtract_rational(a: Rational, b: Rational) -> Rational {
    Rational::new(
        a.n.saturating_mul(b.d)
            .saturating_sub(b.n.saturating_mul(a.d)),
        a.d.saturating_mul(b.d),
    )
}

pub fn multiply_rational(a: Rational, b: Rational) -> Rational {
    Rational::new(a.n.saturating_mul(b.n), a.d.saturating_mul(b.d))
}

pub fn divide_rational(a: Rational, b: Rational) -> Rational {
    if b.n == 0 {
        return Rational::ZERO;
    }
    Rational::new(a.n.saturating_mul(b.d), a.d.saturating_mul(b.n))
}

pub fn is_terminating_decimal(denominator: i64) -> bool {
    if denominator <= 0 {
        return false;
    }
    let mut d = denominator;
    while d % 2 == 0 {
        d /= 2;
    }
    while d % 5 == 0 {
        d /= 5;
    }
    d == 1
}

pub fn format_rational(r: Rational, max_decimals: usize) -> String {
    if r.n == 0 {
        return "0".to_string();
    }
    if r.d == 1 {
        return format!("{}", r.n);
    }
    if is_terminating_decimal(r.d) {
        let val = r.to_f64();
        let factor = 10_f64.powi(max_decimals as i32);
        if (val * factor).round() == val * factor {
            let s = format!("{val:.prec$}", prec = max_decimals);
            let trimmed = s.trim_end_matches('0').trim_end_matches('.');
            return trimmed.to_string();
        }
    }
    format!("{}/{}", r.n, r.d)
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
    if r.d == 1 {
        return serde_json::json!(r.n);
    }
    if is_terminating_decimal(r.d) {
        let val = r.to_f64();
        if (val * 10_000.0).round() == val * 10_000.0 {
            let s = format!("{val:.4}");
            let trimmed = s.trim_end_matches('0').trim_end_matches('.');
            if let Ok(num) = trimmed.parse::<f64>() {
                return serde_json::json!(num);
            }
        }
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
        write!(f, "{}", format_rational(*self, 2))
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
