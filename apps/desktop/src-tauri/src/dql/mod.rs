//! `dql`: Dataview's query language, parsed and lowered onto the Bases engine. Tauri-free (the
//! `writer` CLI and the Dataview feature share it); the engine it lowers to is `crate::bases`.
//!
//! - [`parser`]: `TABLE [WITHOUT ID]`, `LIST [WITHOUT ID]`, `TASK`, `CALENDAR` with `FROM`
//!   (`#tag`, `"folder"`, `"file"`, `[[link]]`, `outgoing([[link]])`, `and`, `or`, `-`, parens),
//!   `WHERE`, `SORT`, `GROUP BY`, `FLATTEN`, `LIMIT`, comments, and the expression language.
//!   Errors carry a line and column.
//! - [`lower`]: the query to a Bases [`Document`](crate::bases::document::Document), the
//!   functions DQL and Bases share rewritten to their Bases form and the rest left to the DQL
//!   dialect (`bases::dialect`). A query whose every clause has a Bases form can be written as
//!   a plain `.base` ("Convert to Base"); the others name the clause that has none.
//! - [`tasks`]: the table that names Dataview's task fields as task-row properties.
//!
//! Spec: `SPECs/dataview-spec.md`.

pub mod ast;
pub mod lower;
pub mod parser;
pub mod tasks;

pub use lower::{lower, DqlError, Kind, Lowered, Unmapped};

#[cfg(test)]
mod tests;
