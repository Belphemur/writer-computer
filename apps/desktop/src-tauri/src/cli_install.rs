//! Tauri-free core of "install the `writer` command on the user's PATH".
//!
//! The running Writer binary is itself the CLI: `main.rs` dispatches to CLI mode when its
//! name is `writer`, so installing is a symlink named `writer` to the app. Two installers share
//! this core (`commands/shell_install.rs` holds them): macOS links `/usr/local/bin/writer` to the
//! bundle's binary (elevating with an admin prompt when needed), Linux links
//! `~/.local/bin/writer` to the AppImage file or the running binary, never elevating. The `.deb`
//! and `.rpm` packages install `/usr/bin/writer` themselves (`tauri.linux.conf.json`).

#![cfg(unix)]

use serde::Serialize;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Where the `.deb` and `.rpm` packages put the `writer` link.
pub const PACKAGE_TARGET: &str = "/usr/bin/writer";

/// Status payload returned to the frontend / menu handler.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallStatus {
    pub target: String,
    /// Absolute path the link points at when installed: the running Writer binary (or the
    /// AppImage file). Stable while the app stays where it is.
    pub source: Option<String>,
    pub installed: bool,
    pub state: CliInstallState,
    /// The target's folder is on the user's PATH (the login shell's, not only this process's).
    pub on_path: bool,
    /// The link belongs to the `.deb`/`.rpm`: nothing to install or remove here.
    pub package: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CliInstallState {
    /// `target` does not exist.
    Missing,
    /// `target` is a symlink pointing at the current Writer binary.
    Installed,
    /// `target` is a symlink, but not to our current binary (older install
    /// or the app moved). Install will overwrite.
    Stale,
    /// `target` exists and is NOT a symlink. We refuse to clobber it.
    Foreign,
}

#[derive(Debug)]
pub enum InstallError {
    SourceUnknown,
    TargetUnknown,
    TargetOccupied(PathBuf),
    /// The link belongs to a package; remove it with the package manager.
    PackageOwned(PathBuf),
    Io(io::Error),
    Elevation(String),
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SourceUnknown => write!(
                f,
                "could not determine the Writer binary path (std::env::current_exe failed)."
            ),
            Self::TargetUnknown => write!(f, "could not determine your home folder."),
            Self::TargetOccupied(p) => write!(
                f,
                "{} already exists and is not a symlink. Remove it manually if you want Writer to manage it.",
                p.display()
            ),
            Self::PackageOwned(p) => write!(
                f,
                "{} belongs to the Writer package. Remove it with your package manager.",
                p.display()
            ),
            Self::Io(err) => write!(f, "{err}"),
            Self::Elevation(msg) => write!(f, "administrator authorization failed: {msg}"),
        }
    }
}

impl std::error::Error for InstallError {}

impl From<io::Error> for InstallError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

impl serde::Serialize for InstallError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&self.to_string())
    }
}

/// Where a link to the running app goes, and what it points at. The two installers differ only
/// in this and in how they get past a permission error.
#[derive(Debug, Clone)]
pub struct Plan {
    pub target: PathBuf,
    pub source: Option<PathBuf>,
}

/// `~/.local/bin/writer`: the user-level bin folder (XDG), no sudo.
pub fn user_target(home: Option<&OsStr>) -> Option<PathBuf> {
    let home = home.filter(|h| !h.is_empty())?;
    Some(Path::new(home).join(".local/bin/writer"))
}

/// What the link points at on Linux. An AppImage's executable lives in a mount that disappears
/// when it exits, so the AppImage file (`$APPIMAGE`) is the stable thing to link to.
pub fn pick_source(appimage: Option<OsString>, exe: Option<PathBuf>) -> Option<PathBuf> {
    appimage
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .or(exe)
}

/// Whether `dir` is one of the folders in the `path_var` list.
pub fn dir_on_path(dir: &Path, path_var: &str) -> bool {
    std::env::split_paths(path_var).any(|p| p == dir)
}

pub fn classify_target(target: &Path, source: Option<&Path>) -> CliInstallState {
    match target.symlink_metadata() {
        Err(err) if err.kind() == io::ErrorKind::NotFound => CliInstallState::Missing,
        Err(_) => CliInstallState::Foreign,
        Ok(meta) => {
            if !meta.file_type().is_symlink() {
                return CliInstallState::Foreign;
            }
            match (fs::read_link(target).ok(), source) {
                (Some(link), Some(src)) if paths_equivalent(&link, src) => {
                    CliInstallState::Installed
                }
                (Some(_), _) => CliInstallState::Stale,
                (None, _) => CliInstallState::Foreign,
            }
        }
    }
}

fn paths_equivalent(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => a == b,
    }
}

/// Try to create the symlink without elevation. `Ok(true)` = created,
/// `Ok(false)` = permission denied, caller should try the elevated path.
pub fn try_symlink_direct(source: &Path, target: &Path) -> Result<bool, InstallError> {
    let parent = target.parent().ok_or_else(|| {
        InstallError::Io(io::Error::new(
            io::ErrorKind::InvalidInput,
            "install target has no parent directory",
        ))
    })?;

    if let Err(err) = fs::create_dir_all(parent) {
        if err.kind() == io::ErrorKind::PermissionDenied {
            return Ok(false);
        }
        return Err(err.into());
    }

    match target.symlink_metadata() {
        Ok(meta) if meta.file_type().is_symlink() => {
            if let Err(err) = fs::remove_file(target) {
                if err.kind() == io::ErrorKind::PermissionDenied {
                    return Ok(false);
                }
                return Err(err.into());
            }
        }
        Ok(_) => return Err(InstallError::TargetOccupied(target.to_path_buf())),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.into()),
    }

    match std::os::unix::fs::symlink(source, target) {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => Ok(false),
        Err(err) => Err(err.into()),
    }
}

/// The status of `plan`'s target. When the package's `/usr/bin/writer` (`package_target`)
/// already links to this binary, that is the answer and `package` is set.
pub fn status(plan: &Plan, package_target: Option<&Path>, path_var: &str) -> CliInstallStatus {
    let source = plan.source.as_deref();
    if let Some(pkg) = package_target {
        if classify_target(pkg, source) == CliInstallState::Installed {
            return build(
                pkg,
                plan.source.clone(),
                CliInstallState::Installed,
                path_var,
                true,
            );
        }
    }
    let state = classify_target(&plan.target, source);
    build(&plan.target, plan.source.clone(), state, path_var, false)
}

fn build(
    target: &Path,
    source: Option<PathBuf>,
    state: CliInstallState,
    path_var: &str,
    package: bool,
) -> CliInstallStatus {
    CliInstallStatus {
        target: target.to_string_lossy().into_owned(),
        source: source.map(|p| p.to_string_lossy().into_owned()),
        installed: state == CliInstallState::Installed,
        state,
        on_path: target.parent().is_some_and(|d| dir_on_path(d, path_var)),
        package,
    }
}

/// Link `plan.target` to the source. `elevate` runs only when the direct attempt is denied
/// (macOS's admin prompt; Linux has none and reports the denial).
pub fn install(
    plan: &Plan,
    package_target: Option<&Path>,
    path_var: &str,
    elevate: impl FnOnce(&Path, &Path) -> Result<(), InstallError>,
) -> Result<CliInstallStatus, InstallError> {
    let source = plan.source.as_deref().ok_or(InstallError::SourceUnknown)?;
    let current = status(plan, package_target, path_var);
    if current.package {
        return Ok(current);
    }
    if !try_symlink_direct(source, &plan.target)? {
        elevate(source, &plan.target)?;
    }
    Ok(status(plan, package_target, path_var))
}

/// Remove the link when it is ours (installed or stale). A foreign file is never touched, a
/// package's link is refused.
pub fn uninstall(
    plan: &Plan,
    package_target: Option<&Path>,
    path_var: &str,
    elevate_unlink: impl FnOnce(&Path) -> Result<(), InstallError>,
) -> Result<CliInstallStatus, InstallError> {
    let current = status(plan, package_target, path_var);
    if current.package {
        return Err(InstallError::PackageOwned(PathBuf::from(current.target)));
    }
    match current.state {
        CliInstallState::Missing => return Ok(current),
        CliInstallState::Foreign => return Err(InstallError::TargetOccupied(plan.target.clone())),
        CliInstallState::Installed | CliInstallState::Stale => {}
    }
    match fs::remove_file(&plan.target) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => elevate_unlink(&plan.target)?,
        Err(err) => return Err(err.into()),
    }
    Ok(status(plan, package_target, path_var))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use tempfile::tempdir;

    // Tests keep source and target in separate subdirectories so they don't
    // collide on macOS's default case-insensitive filesystem (where
    // `Writer` and `writer` are the same file).

    fn make_source(dir: &Path, name: &str) -> PathBuf {
        let source_dir = dir.join("app");
        fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join(name);
        fs::write(&source, b"").unwrap();
        source
    }

    fn target_path(dir: &Path) -> PathBuf {
        dir.join("usr/local/bin/writer")
    }

    fn plan(dir: &Path, source: Option<PathBuf>) -> Plan {
        Plan {
            target: target_path(dir),
            source,
        }
    }

    fn no_elevation(_: &Path, _: &Path) -> Result<(), InstallError> {
        panic!("must not elevate")
    }

    #[test]
    fn classify_missing_target_reports_missing() {
        let dir = tempdir().unwrap();
        assert_eq!(
            classify_target(&target_path(dir.path()), None),
            CliInstallState::Missing
        );
    }

    #[test]
    fn classify_installed_when_symlink_matches_source() {
        let dir = tempdir().unwrap();
        let source = make_source(dir.path(), "Writer");
        let target = target_path(dir.path());
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        symlink(&source, &target).unwrap();
        assert_eq!(
            classify_target(&target, Some(&source)),
            CliInstallState::Installed
        );
    }

    #[test]
    fn classify_stale_when_symlink_points_elsewhere() {
        let dir = tempdir().unwrap();
        let source = make_source(dir.path(), "Writer");
        let other = make_source(dir.path(), "OldWriter");
        let target = target_path(dir.path());
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        symlink(&other, &target).unwrap();
        assert_eq!(
            classify_target(&target, Some(&source)),
            CliInstallState::Stale
        );
    }

    #[test]
    fn classify_foreign_when_target_is_regular_file() {
        let dir = tempdir().unwrap();
        let source = make_source(dir.path(), "Writer");
        let target = target_path(dir.path());
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"not ours").unwrap();
        assert_eq!(
            classify_target(&target, Some(&source)),
            CliInstallState::Foreign
        );
    }

    #[test]
    fn try_symlink_creates_link_and_replaces_stale_one() {
        let dir = tempdir().unwrap();
        let source = make_source(dir.path(), "Writer");
        let target = target_path(dir.path());

        assert!(try_symlink_direct(&source, &target).unwrap());
        let link_meta = target.symlink_metadata().unwrap();
        assert!(link_meta.file_type().is_symlink());
        assert_eq!(fs::read_link(&target).unwrap(), source);

        let other = make_source(dir.path(), "NewWriter");
        assert!(try_symlink_direct(&other, &target).unwrap());
        assert_eq!(fs::read_link(&target).unwrap(), other);
    }

    #[test]
    fn try_symlink_refuses_to_replace_regular_file() {
        let dir = tempdir().unwrap();
        let source = make_source(dir.path(), "Writer");
        let target = target_path(dir.path());
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"not ours").unwrap();

        match try_symlink_direct(&source, &target) {
            Err(InstallError::TargetOccupied(p)) => assert_eq!(p, target),
            other => panic!("expected TargetOccupied, got {other:?}"),
        }
    }

    #[test]
    fn user_target_is_local_bin_under_home() {
        assert_eq!(
            user_target(Some(OsStr::new("/home/ada"))),
            Some(PathBuf::from("/home/ada/.local/bin/writer"))
        );
        assert_eq!(user_target(Some(OsStr::new(""))), None);
        assert_eq!(user_target(None), None);
    }

    #[test]
    fn source_is_the_appimage_file_else_the_running_binary() {
        let exe = Some(PathBuf::from("/tmp/.mount_x/usr/bin/writer-desktop"));
        assert_eq!(
            pick_source(Some("/home/ada/Writer.AppImage".into()), exe.clone()),
            Some(PathBuf::from("/home/ada/Writer.AppImage"))
        );
        assert_eq!(pick_source(Some("".into()), exe.clone()), exe);
        assert_eq!(pick_source(None, None), None);
    }

    #[test]
    fn on_path_matches_whole_folders_only() {
        let dir = Path::new("/home/ada/.local/bin");
        assert!(dir_on_path(dir, "/usr/bin:/home/ada/.local/bin"));
        assert!(!dir_on_path(dir, "/usr/bin:/home/ada/.local/bin2"));
        assert!(!dir_on_path(dir, ""));
    }

    #[test]
    fn install_in_a_temp_home_links_reports_path_and_uninstalls() {
        let home = tempdir().unwrap();
        let source = make_source(home.path(), "Writer.AppImage");
        let target = user_target(Some(home.path().as_os_str())).unwrap();
        let plan = Plan {
            target: target.clone(),
            source: Some(source.clone()),
        };
        let bin = target.parent().unwrap().to_string_lossy().into_owned();

        let off_path = status(&plan, None, "/usr/bin");
        assert_eq!(off_path.state, CliInstallState::Missing);
        assert!(!off_path.on_path);

        let done = install(&plan, None, &bin, no_elevation).unwrap();
        assert!(done.installed && done.on_path && !done.package);
        assert_eq!(fs::read_link(&target).unwrap(), source);

        let gone = uninstall(&plan, None, &bin, |_| panic!("must not elevate")).unwrap();
        assert_eq!(gone.state, CliInstallState::Missing);
        assert!(target.symlink_metadata().is_err());
    }

    #[test]
    fn a_stale_link_is_replaced_and_a_foreign_file_is_kept() {
        let dir = tempdir().unwrap();
        let source = make_source(dir.path(), "Writer");
        let plan = plan(dir.path(), Some(source.clone()));
        let old = make_source(dir.path(), "Old");
        fs::create_dir_all(plan.target.parent().unwrap()).unwrap();
        symlink(&old, &plan.target).unwrap();
        assert!(install(&plan, None, "", no_elevation).unwrap().installed);

        fs::remove_file(&plan.target).unwrap();
        fs::write(&plan.target, b"not ours").unwrap();
        assert!(matches!(
            install(&plan, None, "", no_elevation),
            Err(InstallError::TargetOccupied(_))
        ));
        assert!(matches!(
            uninstall(&plan, None, "", |_| panic!("must not elevate")),
            Err(InstallError::TargetOccupied(_))
        ));
        assert_eq!(fs::read(&plan.target).unwrap(), b"not ours");
    }

    #[test]
    fn a_denied_directory_goes_to_the_elevation_hook() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let source = make_source(dir.path(), "Writer");
        let locked = dir.path().join("locked");
        fs::create_dir(&locked).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o500)).unwrap();
        // root ignores directory modes, so the denial cannot be provoked there
        if fs::create_dir(locked.join("probe")).is_ok() {
            return;
        }
        let plan = Plan {
            target: locked.join("bin/writer"),
            source: Some(source),
        };
        let err = install(&plan, None, "", |_, _| {
            Err(InstallError::Elevation("no sudo".into()))
        })
        .unwrap_err();
        assert!(matches!(err, InstallError::Elevation(_)));
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[test]
    fn a_package_link_is_the_status_and_cannot_be_removed_here() {
        let dir = tempdir().unwrap();
        let source = make_source(dir.path(), "writer-desktop");
        let pkg = dir.path().join("usr/bin/writer");
        fs::create_dir_all(pkg.parent().unwrap()).unwrap();
        symlink(&source, &pkg).unwrap();
        let plan = plan(dir.path(), Some(source));

        let on_path = pkg.parent().unwrap().to_string_lossy().into_owned();
        let s = status(&plan, Some(&pkg), &on_path);
        assert!(s.installed && s.package && s.on_path);
        assert_eq!(s.target, pkg.to_string_lossy());

        // Installing changes nothing, and nothing is linked into the user folder.
        assert!(
            install(&plan, Some(&pkg), "", no_elevation)
                .unwrap()
                .package
        );
        assert!(plan.target.symlink_metadata().is_err());
        assert!(matches!(
            uninstall(&plan, Some(&pkg), "", |_| panic!("must not elevate")),
            Err(InstallError::PackageOwned(_))
        ));
    }
}
