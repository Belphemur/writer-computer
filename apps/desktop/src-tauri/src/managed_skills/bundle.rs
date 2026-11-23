//! The bundled skill sources. The files live under `src-tauri/skills/<name>/`
//! as reviewable Markdown and are compiled into the binary with `include_str!`
//! (no new dependency). Adding a skill or a reference file is one entry here;
//! `tests::bundle_matches_skills_directory` fails when this table and the
//! directory disagree.

/// Bump when any bundled file changes (`tests::bundle_fingerprint_is_current`
/// tells you the new fingerprint). The version orders installs: a vault whose
/// installed version is newer than this binary's is left alone.
pub const BUNDLE_VERSION: u32 = 27;

/// SHA-256 over every bundled file (see `mod.rs::bundle_fingerprint`). It exists
/// only to make a forgotten `BUNDLE_VERSION` bump a failing test.
#[cfg(test)]
pub const BUNDLE_FINGERPRINT: &str =
    "675c107fad9b104e3cdaff48e6f91eeb17b9be2ed64000d74a1e01a6173ab0db";

pub struct BundledFile {
    /// Path inside the skill directory, forward slashes.
    pub rel: &'static str,
    pub content: &'static str,
}

pub struct BundledSkill {
    /// Directory name and the `name:` of its `SKILL.md`.
    pub name: &'static str,
    /// `SKILL.md` first, then references.
    pub files: &'static [BundledFile],
}

/// Every bundled skill: the core table below followed by the ones features contribute
/// (`features::Feature::skills`). The sync, the prompt and the fingerprint read this.
pub fn all() -> impl Iterator<Item = &'static BundledSkill> {
    SKILLS.iter().chain(crate::features::skills())
}

macro_rules! file {
    ($skill:literal, $rel:literal) => {
        BundledFile {
            rel: $rel,
            content: include_str!(concat!("../../skills/", $skill, "/", $rel)),
        }
    };
}

pub static SKILLS: &[BundledSkill] = &[
    BundledSkill {
        name: "writer-cli",
        files: &[
            file!("writer-cli", "SKILL.md"),
            file!("writer-cli", "references/commands.md"),
        ],
    },
    BundledSkill {
        name: "writer-search",
        files: &[file!("writer-search", "SKILL.md")],
    },
];
