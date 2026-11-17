//! The agent's Tauri commands, one file per concern; all thin glue that resolves the calling
//! window and its vault and calls the Tauri-free `crate::agent` core.
pub mod chats;
pub mod projects;
pub mod session;
pub mod skills;
