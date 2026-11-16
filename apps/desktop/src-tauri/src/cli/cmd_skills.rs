//! `skills:sync`: install or update the Writer-managed agent skills of the
//! vault (`SPECs/managed-vault-skills-spec.md`).

use super::args::Args;
use super::registry::CommandSpec;
use super::{CliError, Ctx};
use crate::managed_skills::{self, Action, Mode};

pub fn skills_sync(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let mode = if args.flag("check") {
        Mode::Check
    } else {
        Mode::Apply
    };
    let report = managed_skills::sync(ctx.root()?, mode).map_err(CliError::fail)?;
    let mut out = String::new();
    let mut errors = Vec::new();
    for o in &report.outcomes {
        out.push_str(&format!("{}\t{}", o.dir, o.action.as_str()));
        if !o.detail.is_empty() {
            out.push_str(&format!("\t{}", o.detail));
        }
        out.push('\n');
        match o.action {
            Action::Error => errors.push(format!("{}: {}", o.dir, o.detail)),
            Action::SkippedUserOwned | Action::SkippedNewer => {
                ctx.warn(format!("{}: {}", o.dir, o.detail))
            }
            _ => {}
        }
    }
    if errors.is_empty() {
        Ok(out)
    } else {
        Err(CliError::fail(errors.join("; ")))
    }
}
