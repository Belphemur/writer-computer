//! `dql`: the CLI front end of the DQL engine (`crate::dql`) over the Bases executor and the
//! vault index. The app's ```dataview blocks run the same lowering and executor, so a query
//! printed here is the block's rows.

use super::args::Args;
use super::cmd_bases::format_result;
use super::registry::CommandSpec;
use super::{CliError, Ctx};
use crate::bases::context::SystemClock;
use crate::dql;
use crate::index::bases_source::run_base_view;

pub fn dql(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let query = args
        .get("query")
        .ok_or_else(|| CliError::Usage("dql needs query=\"TABLE ...\"".into()))?;
    let lowered = dql::lower(query).map_err(|e| CliError::fail(e.to_string()))?;
    // `this` is the note the query would sit in (`file=` or `path=`), when one is named
    let this = match (args.get("file"), args.get("path")) {
        (None, None) => None,
        _ => Some(ctx.target(args)?.rel),
    };
    let clock = SystemClock {
        offset_minutes: ctx.env.utc_offset_minutes,
    };
    let result = run_base_view(
        ctx.index()?,
        &lowered.live_document(),
        None,
        this.as_deref(),
        &clock,
    )?;
    if let Some(e) = &result.error {
        let mut msg = e.message.clone();
        if let Some(x) = &e.expression {
            msg.push_str(&format!(" (in `{x}`)"));
        }
        if let Some(p) = &e.path {
            msg.push_str(&format!(" (on {p})"));
        }
        return Err(CliError::Fail(msg));
    }
    format_result(&result, &format)
}
