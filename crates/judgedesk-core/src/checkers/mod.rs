pub mod custom;
pub mod standard;

pub use custom::{
    parse_custom_checker_exit, parse_custom_checker_exit_rational, parse_partial_score,
    CustomCheckerResult,
};
pub use standard::{
    is_built_in_checker, is_polygon_checker, is_standard_checker, run_standard_checker,
    CheckerVerdict, StandardCheckerResult,
};
