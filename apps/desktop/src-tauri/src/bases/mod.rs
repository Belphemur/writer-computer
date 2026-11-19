//! Obsidian Bases engine: `.base` parsing, the expression language and the
//! query executor. Pure Rust, no `tauri` types and no dependency on the vault
//! index: data comes in through [`context::RowContext`] and
//! [`query::RowSource`], time through [`context::Clock`]. The app (a
//! `base_query` command) and the `writer` CLI share this one engine.
//!
//! See `README.md` in this folder for the module map and the U-CHOICES table.

pub mod ast;
pub mod choices;
pub mod context;
pub mod datetime;
pub mod dialect;
pub mod document;
pub mod functions;
pub mod interp;
pub mod lexer;
pub mod parser;
pub mod query;
pub mod value;
pub mod wire;

#[cfg(test)]
mod testkit;
#[cfg(test)]
mod tests;
