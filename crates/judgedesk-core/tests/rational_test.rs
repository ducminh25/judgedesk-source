use judgedesk_core::rational::*;
use serde_json::json;

#[test]
fn test_gcd() {
    assert_eq!(gcd(12, 18), 6);
    assert_eq!(gcd(100, 25), 25);
    assert_eq!(gcd(7, 13), 1);
    assert_eq!(gcd(-6, 8), 2);
}

#[test]
fn test_create_rational_simplifies_and_handles_signs() {
    assert_eq!(Rational::new(6, 4), Rational { n: 3, d: 2 });
    assert_eq!(Rational::new(-6, 4), Rational { n: -3, d: 2 });
    assert_eq!(Rational::new(6, -4), Rational { n: -3, d: 2 });
    assert_eq!(Rational::new(-6, -4), Rational { n: 3, d: 2 });
    assert_eq!(Rational::new(0, 5), Rational { n: 0, d: 1 });
}

#[test]
fn test_parse_rational() {
    assert_eq!(parse_rational("1/3"), Rational { n: 1, d: 3 });
    assert_eq!(parse_rational("5/3"), Rational { n: 5, d: 3 });
    assert_eq!(parse_rational("2"), Rational { n: 2, d: 1 });
    assert_eq!(parse_rational("0.5"), Rational { n: 1, d: 2 });
    assert_eq!(parse_rational("3.5"), Rational { n: 7, d: 2 });
    assert_eq!(parse_rational("0.35"), Rational { n: 7, d: 20 });

    // Floating point precision epsilon snapping
    assert_eq!(
        parse_rational_f64(2.99999999999999),
        Rational { n: 3, d: 1 }
    );
    assert_eq!(
        parse_rational_f64(3.499999999999987),
        Rational { n: 7, d: 2 }
    );
}

#[test]
fn test_fraction_operations() {
    let one_third = parse_rational("1/3");

    // 1/3 * 6 = 2
    let times_six = multiply_rational(one_third, Rational::new(6, 1));
    assert_eq!(times_six, Rational { n: 2, d: 1 });
    assert_eq!(format_rational(times_six, 2), "2");

    // 1/3 * 5 = 5/3
    let times_five = multiply_rational(one_third, Rational::new(5, 1));
    assert_eq!(times_five, Rational { n: 5, d: 3 });
    assert_eq!(format_rational(times_five, 2), "5/3");

    // Summing 6 tests of 1/3
    let mut sum = Rational::ZERO;
    for _ in 0..6 {
        sum = add_rational(sum, one_third);
    }
    assert_eq!(format_rational(sum, 2), "2");

    // Summing 10 tests of 0.35 (3.5)
    let point35 = parse_rational("0.35");
    let mut sum_point35 = Rational::ZERO;
    for _ in 0..10 {
        sum_point35 = add_rational(sum_point35, point35);
    }
    assert_eq!(format_rational(sum_point35, 2), "3.5");
}

#[test]
fn test_format_score() {
    // Integers
    assert_eq!(format_score(&json!(2), 2), "2");
    assert_eq!(format_score(&json!("2"), 2), "2");
    assert_eq!(format_score(&json!(0), 2), "0");

    // Terminating decimals (<= 2 places)
    assert_eq!(format_score(&json!(0.5), 2), "0.5");
    assert_eq!(format_score(&json!(3.5), 2), "3.5");
    assert_eq!(format_score(&json!(1.25), 2), "1.25");
    assert_eq!(format_score(&json!("0.35"), 2), "0.35");

    // IEEE 754 precision bug cases
    assert_eq!(format_score(&json!(2.99999999999999), 2), "3");
    assert_eq!(format_score(&json!(3.499999999999987), 2), "3.5");

    // Repeating fractions
    assert_eq!(format_score(&json!("1/3"), 2), "1/3");
    assert_eq!(format_score(&json!("5/3"), 2), "5/3");
    assert_eq!(format_score(&json!("10/3"), 2), "10/3");
    assert_eq!(format_score(&json!("1/6"), 2), "1/6");
}
