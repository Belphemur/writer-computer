# Maintainer and supply-chain review: specta / tauri-specta vs ts-rs

Checked 2026-11-17 from public sources only. Scope: can the maintainers be trusted, and how do the two stacks compare on supply-chain hygiene. The technical comparison (shapes, bigint, commands) is already in the Q7 "Evidence" section of `docs/decisions/2026-11-17-build-first-party-features-as-built-in-plugins-with-one-manifest-one-rust-trait-and-one-registry-line.md` and is not repeated here.

Legend: **[F]** verified fact with source; **[I]** inference (mine, can be wrong). Anything I could not verify is listed in "Unverified / limits".

Method notes: crates.io API (`https://crates.io/api/v1/crates/<crate>`, `/owners`, `/reverse_dependencies`), GitHub REST API read-only calls (`gh api repos/...`), the crate sources in the local cargo registry, `cargo tree` in a scratch project outside the repo (`/private/tmp/claude-502/-Users-antoinea-repos/60ac003b-646c-4962-af90-f449c6cbef84/scratchpad/typegen-trust/`), raw files of cargo-vet registries. `cargo audit` and `cargo deny` are not installed (not installed, per instructions), so RustSec was checked by looking for crate directories in `rustsec/advisory-db`.

## Verdict (short)

- **Neither stack shows a trust red flag.** No malicious-behaviour signals, no RustSec advisory and no GitHub security advisory for any of the nine crates, MIT everywhere, no network access or out-of-tree writes in any proc-macro or build script. [F, sections 4 and 2]
- **The two risks are different, not one better than the other.** specta/tauri-specta: one very active, well-known maintainer (bus factor 1), a permanent-looking release-candidate state with breaking changes between rcs, and visible AI-assisted triage. ts-rs: stable semver and much wider adoption, but the project is thinly maintained: its only crates.io owner made 4 commits in the last 12 months, the person who now merges PRs is not a crates.io owner, and 10 merged commits (Feb to Nov 2026) are unreleased 9.5 months after 12.0.1. [F]
- **For Writer's decision (types only, generated bindings committed, regenerated and diffed by a Rust test):** the ADR choice of `ts-rs` for types remains defensible on trust grounds, mainly because exit cost is near zero (committed `.ts` files, derive-only dependency, 3 added crates). The specta stack is credible and arguably better supported by Tauri itself, but its instability is a maintenance cost, not a security problem. Confidence: moderate-high that neither is unsafe to depend on; moderate on the relative ranking (it rests on inferences about continuity). **Mitigations either way:** pin exact versions, review the lockfile diff on each bump, add `cargo deny`/`cargo vet` to CI later.

## 1. Who owns and maintains each crate

| Crate               | crates.io owners [F]                            | Created | Latest                   | Yanked |
| ------------------- | ----------------------------------------------- | ------- | ------------------------ | ------ |
| specta              | 1 individual: `oscartbeaumont`                  | 2022-07 | 2.0.0-rc.28 (2026-11-05) | 1.0.1  |
| specta-macros       | same                                            | 2022-07 | rc.28                    | 0.0.1  |
| specta-typescript   | same                                            | 2024-07 | 0.0.15 (2026-11-05)      | none   |
| specta-serde        | same                                            | 2024-07 | 0.0.15                   | none   |
| specta-util         | same                                            | 2024-07 | 0.0.15                   | none   |
| tauri-specta        | 2 individuals: `oscartbeaumont`, `Brendonovich` | 2022-11 | 2.0.0-rc.29 (2026-11-13) | none   |
| tauri-specta-macros | `oscartbeaumont`                                | 2022-11 | rc.29                    | 0.0.2  |
| ts-rs               | 1 individual: `NyxCode` (no team owner)         | 2020-12 | 12.0.1 (2026-01-31)      | none   |
| ts-rs-macros        | `NyxCode`                                       | 2020-12 | 12.0.1                   | none   |

Sources: `https://crates.io/api/v1/crates/<crate>/owner_user` and `/owner_team` (all `owner_team` lists empty); versions from `https://crates.io/api/v1/crates/<crate>`. I could not see owner-change history (crates.io does not expose it in the public API); [I] owner sets look unchanged because the first and latest publishers match the owners.

Repositories: `https://github.com/specta-rs/specta` and `https://github.com/specta-rs/tauri-specta` (organization `specta-rs`, created 2024-01-31, 10 public repos, its only public member is `oscartbeaumont`; `https://api.github.com/orgs/specta-rs/members`). The org description is "Rust crates for building better web apps". Your belief is correct: all five specta crates and tauri-specta live in `specta-rs`. ts-rs lives in the company organization `Aleph-Alpha` ("Aleph Alpha GmbH", `https://github.com/Aleph-Alpha/ts-rs`), but the crates.io owner is an individual, not the company.

### Commits (GitHub contributors/commits API, last 12 months from 2025-11-16)

| Repo                   | Human committers, last 12 months                           | Share of top committer           | Others                                                                       |
| ---------------------- | ---------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------- |
| specta-rs/specta       | `oscartbeaumont` 593                                       | about 96% of human commits       | `johncarmack1984` 16, 5 one-off contributors; dependabot 33                  |
| specta-rs/tauri-specta | `oscartbeaumont` 197                                       | about 96%                        | `johncarmack1984` 4, `rofinn` 3, 3 one-offs; dependabot 18, github-actions 5 |
| Aleph-Alpha/ts-rs      | `gustavo-shigueo` 5, `NyxCode` 4, `mmalecki` 2, 4 one-offs | spread thin; 16 commits in total | author of record on the main branch changes to the merge flow                |

All-time (contributors stats API, `https://api.github.com/repos/<repo>/stats/contributors`): specta 862 commits by Oscar (first 2023-01), 37 by `Brendonovich` (last 2024-07); tauri-specta 264 by Oscar, 71 by `Brendonovich` (last commit 2024-07); ts-rs 256 by `NyxCode` (2020-12 to 2026-01), 168 by `escritorio-gustavo` (2023-12 to 2024-09, an account that also appears as `gustavo-shigueo`, 35 commits, still active; same person is [I] likely but not stated), 20 by `jerm-dro` (2021), 15 by `arendjr` (2021).

Bus factor [I]: specta stack = 1 (very active). ts-rs = effectively 2 people but split: `NyxCode` is the only one who can publish to crates.io [F, owner list]; `gustavo-shigueo` merges PRs (e.g. PR 508 `merged_by=gustavo-shigueo`, `https://api.github.com/repos/Aleph-Alpha/ts-rs/pulls/508`) but is not a crates.io owner [F]. Whether he has other publish rights is not visible.

### People (only what their public profiles state; `https://api.github.com/users/<login>`)

- **Oscar Beaumont** (`oscartbeaumont`): GitHub account since 2016, 421 followers, no company or bio listed, blog `otbeaumont.me`. Maintains `rspc` (1,391 stars, now in the `specta-rs` org, "A framework for building typesafe web backends in Rust"), ElectronPlayer (505 stars). Public member of the `tauri-apps` GitHub org [F, `https://api.github.com/orgs/tauri-apps/public_members`], with 13 commits in `tauri-apps/tauri` including specta-related fixes (e.g. "fix(specta): don't use `#[specta(rename = ...)]` with `tauri::ipc::Channel`", 2026-01-24; `https://api.github.com/repos/tauri-apps/tauri/commits?author=oscartbeaumont`). Member of the `mattrax` org (profile: "Open source MDM for all your devices", `https://mattrax.app`). Funding: GitHub Sponsors listing (2 sponsors publicly counted, GraphQL `sponsors.totalCount`) and a PayPal link in `.github/FUNDING.yml` of specta and tauri-specta. No employer stated.
- **Brendan Allan** (`Brendonovich`): co-owner of tauri-spectа on crates.io; profile company `@anomalyco`, bio "opencode at anomaly"; public member of `tauri-apps`. No commits to specta or tauri-specta since 2024-07 [F], so he is a latent co-owner, not an active maintainer.
- **NyxCode** (ts-rs): profile bio "Student @ Karlsruhe Institute of Technology", 32 followers, no company. GitHub Sponsors listing exists (GraphQL `hasSponsorsListing: true`); no FUNDING.yml in ts-rs. Not stated anywhere I found: any link between this person and Aleph Alpha beyond the repository living in that org [F that it is hosted there].
- **Gustavo Shigueo** (`gustavo-shigueo`): bio "Full-Stack Developer ... Rust"; the main recent ts-rs committer and PR merger.

I did not look beyond public profiles and I make no judgement about the people. [I] A single individual with no listed employer is typical for this part of the Rust ecosystem; it is a continuity factor, not a character signal.

## 2. Track record

### Release history and cadence (crates.io versions API)

- **specta 2.0 line**: rc.1 2023-07, then rc.2 to rc.22 within 18 months (2023-09 to 2025-01), then **a 13.7-month gap** (rc.22 2025-01-12 to rc.23 2026-03-02), then rc.24 2026-03, rc.25 2026-05, rc.26 and rc.27 2026-10-21, rc.28 2026-11-05. 28 rcs in 40 months. [F]
- **tauri-specta 2.0 line**: rc.1 2023-10, rc.21 2025-01-13, then gap to rc.24 2026-03-30 (rc.22 and rc.23 were never published to crates.io), rc.25 2026-05, rc.26 2026-10, rc.28 2026-11-11, rc.29 2026-11-13 (rc.27 not published for this crate). [F]
- **specta-typescript / specta-serde**: 0.0.1 2024-07, 0.0.9 2025-01, then 0.0.10 to 0.0.15 between 2026-03 and 2026-11. [F]
- **ts-rs**: 2.0 2020-12; 6.x 2021-11 to 2022-11; 7.0 2023-08; 8.0 2024-03; 9.0 2024-06; 10.0 2024-09; 11.0 2025-06; 11.1.0 2025-10; 12.0.0 and 12.0.1 2026-01-31. About one major per 6 to 9 months, each with a `CHANGELOG.md` "Breaking" section (`https://github.com/Aleph-Alpha/ts-rs/blob/main/CHANGELOG.md`). **9.5 months with no release** at the check date, while 10 commits landed after the tag (`https://api.github.com/repos/Aleph-Alpha/ts-rs/commits?since=2026-02-01`), and the CHANGELOG `master` section is still empty. [F]
- **Yanked versions**: specta 1.0.1, specta-macros 0.0.1, tauri-specta-macros 0.0.2 (early, 2022 to 2023). None for ts-rs, specta-typescript, specta-serde, tauri-specta. [F]
- **Breaking change frequency**: specta rcs break regularly by design. Evidence: issues "Compilation breakage of 2.0.0-rc.4" (2023-10, `https://github.com/specta-rs/specta/issues/152`) and a new-project resolve picking an incompatible `specta-macros` rc (2023-11, `.../issues/173`); tauri-specta exact-pins `specta =2.0.0-rc.28`. The maintainer himself lists intended breaking changes before 2.0 (see next point). ts-rs breaks with semver majors, documented in the changelog (12.0 changed the generated type of unit structs and `HashMap`, for example). [F]
- **Is the rc status intentional?** Yes, stated by the maintainer on 2026-10-21 in `https://github.com/specta-rs/tauri-specta/issues/247` ("Release candidate status for tauri-specta v2"): no date commitment; tauri-specta needs Specta v2 "which is itself still in beta"; the crate "is being used in production" and "the API surface is close to what 2.0 will be, but it is not frozen"; remaining intended breaking items #166, #169, #170, #220 on a `2.0.0` milestone; advice: "pin exactly (`=2.0.0-rc.X`)". The specta README calls TypeScript "Stable" but also says "The Specta exporter crates are pre-1.0 and actively developed" (`https://github.com/specta-rs/specta#readme`). [F]
- **AI-assisted maintenance, disclosed**: the answer above ends with "Generated on _MrBeast_ using _console-personal-openrouter/deepseek/deepseek-v4.1-flash_", posted under the maintainer's account. A search finds the same footer on 43 items in specta and 31 in tauri-specta (`https://api.github.com/search/issues?q=repo:specta-rs/specta+"Generated on"+MrBeast`). The specta contributors list also shows a `claude` account with 11 commits (2026-07), and the repo has an `AGENTS.md`. [F] [I] This explains the recent high commit volume (about 600 commits in 12 months) and is not by itself a quality problem, but it changes how much human review a given change gets; the lockfile-diff and test discipline on our side should assume that.

### Responsiveness (sample of the 15 most recent externally authored issues/PRs per repo, first event by someone else: comment, review or close)

| Repo         | Responded | Median first response                                                                     | Not answered                                                   |
| ------------ | --------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| specta       | 13 of 15  | about 177 h (7 days); range 0.1 h to 2,160 h                                              | 2 (open, created 2026-11-14)                                   |
| tauri-specta | 15 of 15  | about 1,187 h (50 days); range 0.9 h to 3,086 h; the newest issue got an answer in 12.7 h | 0                                                              |
| ts-rs        | 9 of 15   | about 21 h among those answered                                                           | 6 (open: issues 496, 500, 503; PRs 499 from 2026-09, 501, 502) |

Caveats: "close" counts as a response and may be self-closing by the author; the sample is small; outliers dominate the medians. Script: `scratchpad/typegen-trust/resp.py`. [F for the raw data, I for its reading] Reading [I]: specta responses cluster in bursts when the maintainer works on the repo (many 2,000+ hour waits were answered on the same day in 2026-10, i.e. a backlog sweep); ts-rs answers fast when someone is looking, but external PRs and issues can sit unanswered for months (PR 499 open since 2026-09-03).

Open/closed: specta 7 open and 368 closed issues, 2 open and 254 closed PRs; tauri-specta 1 and 141 issues, 1 and 124 PRs; ts-rs 19 and 185 issues, 12 and 261 PRs. (`https://api.github.com/search/issues?q=repo:<repo>+is:issue+is:open` etc.) [F]

### Security handling

- No `SECURITY.md` (root or `.github/`) in any of the three repos. GitHub's published security advisories list is empty for all three. [F]
- **RustSec**: no directory for `specta`, `specta-macros`, `specta-typescript`, `specta-serde`, `specta-util`, `tauri-specta`, `tauri-specta-macros`, `ts-rs`, `ts-rs-macros` under `crates/` in `https://github.com/rustsec/advisory-db` (lookup method validated against a known crate, `time`). `paste` (a dependency only of the specta stack) has RUSTSEC-2024-0436 (unmaintained, informational). `Inflector`, `termcolor`, `darling`, `rustc_version` have none. [F]
- The most recent tauri-specta commit titled "Fix bindings exports writing outside repository" (2026-11-13) only changes two doc-test code fences to `no_run` (diff checked); it is not a security fix. [F]
- [I] The absence of advisories means "no reported issues", not "audited": neither project has a disclosure policy file, so a reporter would have to find a private channel.

## 3. Adoption and ecosystem trust

| Signal                                                       | specta             | tauri-specta | ts-rs       |
| ------------------------------------------------------------ | ------------------ | ------------ | ----------- |
| crates.io total downloads                                    | 4.75 M (mostly v1) | 1.95 M       | 23.6 M      |
| crates.io recent downloads (90 d)                            | 2.69 M             | 0.90 M       | 10.9 M      |
| Dependent crates on crates.io                                | 151                | 9            | 452         |
| GitHub dependents (repos, github.com/.../network/dependents) | 1,874              | 1,336        | 3,557       |
| Stars / forks                                                | 656 / 74           | 818 / 76     | 1,958 / 174 |

[F] all rows (crates.io API, GitHub API, dependents HTML). specta-typescript: 3.2 M downloads, 29 dependent crates; specta-serde 22.

Notable dependents, verified from the crates.io reverse-dependency API unless noted:

- **Tauri itself depends on specta**: `tauri` 2.12.5 has an optional `specta` feature (`specta ^2.0.0-rc.16`, local `Cargo.toml`) that adds type support for `AppHandle`, `State`, `Window`, `Webview`, `WebviewWindow` and `Channel`, announced in the Tauri 2.0 blog post (`https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/blog/tauri-2.0.mdx`, line 297); official plugins `tauri-plugin-haptics` and geolocation depend on specta (`crates.io` reverse deps of specta, `plugins-workspace` code search). `awesome-tauri` lists "Tauri Specta ... Completely typesafe Tauri commands" for v2 (`https://github.com/tauri-apps/awesome-tauri`, README line 137). Both specta maintainers are public members of the `tauri-apps` org. [F] I did not find tauri-specta in the Tauri v2 documentation pages themselves (code search of `tauri-apps/tauri-docs` for "tauri-specta" returned 0); [I] Tauri tolerates and integrates with it without officially endorsing it as the typed-commands solution.
- **Spacedrive** (39.5 k stars) depends on specta in its workspace manifests, but via a git fork (`specta = { git = "https://github.com/jamiepine/specta", branch = "main" }`, `https://github.com/spacedriveapp/spacedrive/blob/main/Cargo.toml`), not the crates.io release. [F] The "Spacedrive uses specta/rspc" association is true historically (the same author created rspc for it) but its current use is a fork, so it is weaker evidence of production use of the published crates than it looks.
- ts-rs dependents include `faststr` (8.5 M downloads, an optional integration), `docx-rs`, the `kcl-*` and `kittycad-point` crates, `opentalk-types-common-identifiers`, and `rolldown_debug_action`; GitHub code search finds `ts-rs` in 2 Cargo.toml files in the `rolldown` org. [F] "Aleph Alpha uses ts-rs internally" is **not verified**: the repo is in their org, but I found no statement and the code search hit a rate limit.
- tauri-specta dependents on crates.io are small (9 crates, e.g. `tauri-plugin-machine-uid`, `tauri-plugin-state`, `tauri-plugin-midi`); [I] most real use is in applications, which crates.io cannot show; GitHub counts 1,336 dependent repositories.

## 4. Build and supply-chain hygiene

**Proc-macros and build scripts** (read from the local registry sources of the exact versions: specta 2.0.0-rc.28, specta-macros rc.28, specta-serde 0.0.15, specta-typescript 0.0.15, specta-util 0.0.15, tauri-specta rc.29, tauri-specta-macros rc.29, ts-rs 12.0.1, ts-rs-macros 12.0.1):

- `specta-macros`, `tauri-specta-macros`, `ts-rs-macros`: no file, process, network or environment access in `src/` (grep for `std::fs`, `std::net`, `Command`, `env::var`, `include_str`, `env!`). [F]
- Only `specta` has a `build.rs`: it sets a `is_nightly` cfg using `rustc_version` (reads `RUSTC_BOOTSTRAP` and rustc metadata, prints `cargo:rustc-cfg`). No network, no writes. [F] `ts-rs` and the rest have no build script. [F]
- Runtime file writes (not compile time): `ts-rs` writes `.ts` files from tests generated by `#[ts(export)]` (`src/export.rs`, honours `TS_RS_EXPORT_DIR`), so `cargo test` writes under a configured dir. `specta-typescript`'s exporter writes the output path you give it and, in multi-file/directory mode, **deletes stale files it recognises as generated by specta** (`cleanup_stale_files`, guarded by `is_generated_specta_file`) and removes empty directories under the export root. [F] [I] Point the exporter at a dedicated `bindings` directory, never at a folder with hand-written files.
- No `unsafe`-heavy or native build deps in either stack; neither adds C code. [I] from the dependency lists below (not an unsafe audit).

**cargo-vet registries** (raw `audits.toml` of Google `rust-crate-audits`, Mozilla `supply-chain`, Bytecode Alliance `wasmtime`, `divviup/libprio-rs`): no entries for any of the nine crates in any registry. Entries exist only for `paste` (Google 3, Mozilla 3) and `termcolor` (Google 5, Mozilla 1). So neither stack has third-party audits in these registries; ts-rs's one third-party addition (`termcolor`) is audited by both, specta's `paste` is audited by both, `Inflector` by none. [F]

**Release process**: specta and tauri-specta releases since specta rc.27 and tauri-specta rc.28 are published through crates.io **trusted publishing** (GitHub Actions OIDC; `trustpub_data.provider = github`, `published_by = null`, `.github/workflows/release.yml` states no long-lived registry token is stored, uses a `release` environment, and pins actions by commit SHA). Earlier versions were published by hand from the maintainer's account. ts-rs releases (including 12.0.1) are published manually by `NyxCode` with no trusted-publishing data. [F] [I] The specta process is the stronger one today; ts-rs has no automated, auditable publish path and depends on one person's credentials.

**Dependency footprint**, measured with `cargo tree -e normal,build` in a scratch project with `tauri =2.12.5`, `serde`, `serde_json` as the baseline (284 package entries, 219 unique crate versions on this host target, default features). Writer's `Cargo.lock` has none of `paste`, `Inflector`, `termcolor` [F, `apps/desktop/src-tauri/Cargo.lock`].

| Stack                                                                                                               | Crates added over the baseline                                                                                                                                                                                                                                                       | Third-party among them |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `specta =2.0.0-rc.28` + `specta-typescript =0.0.15` + `tauri-specta =2.0.0-rc.29` (features `derive`, `typescript`) | 9: specta, specta-macros, specta-serde, specta-typescript, specta-util, tauri-specta, tauri-specta-macros (all by the same maintainer) + `Inflector` 0.11.4 (BSD-2-Clause) + `paste` 1.0.15 (MIT OR Apache-2.0, unmaintained per RUSTSEC-2024-0436, informational, no vulnerability) | 2                      |
| `ts-rs =12.0.1` (default features)                                                                                  | 3: ts-rs, ts-rs-macros (same maintainer) + `termcolor` 1.4.1 (Unlicense OR MIT)                                                                                                                                                                                                      | 1                      |

The ADR says `thiserror 2` is also an addition for ts-rs; it is already in this baseline via Tauri, so that does not add a crate here. Optional integrations (chrono, uuid, serde_json, `dprint-plugin-typescript` via ts-rs `format`) are off by default and would add crates only if enabled.

**Licences**: every added crate is MIT, Unlicense/MIT, BSD-2-Clause or MIT OR Apache-2.0, all compatible with GPL-3.0. The whole specta-stack tree (Tauri included) has 13 licence families including MPL-2.0 (5 crates), Unicode-3.0, Zlib and BSD-3-Clause, all from the existing Tauri baseline, not from the added crates. [F]

## 5. Comparison

| Dimension                               | specta + specta-typescript + tauri-specta                                                                                                                                                                                                 | ts-rs                                                                                                                                                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Maintainer depth                        | One principal (about 96% of commits), a second co-owner on tauri-specta inactive since 2024-07, one growing contributor. Org with one public member.                                                                                      | Original author owns crates.io but made 4 commits in 12 months; one active committer/merger who is not a crates.io owner; several one-off contributors. Hosted in a company org.                                                                         |
| Activity                                | Very high: about 600 commits in 12 months, 6 releases in 8 months (partly AI-assisted, disclosed).                                                                                                                                        | Low: 16 commits in 12 months, no release since 2026-01-31, 10 merged commits unreleased.                                                                                                                                                                 |
| Track record                            | 4 years, 28 rcs, never stable for v2; breaking changes between rcs; one 13.7-month release gap; 3 yanked early versions; explicit statement of why rc.                                                                                    | 6 years, regular majors with changelogs, none yanked; slower recently.                                                                                                                                                                                   |
| Adoption                                | Core library 151 crate dependents, 1,874 GitHub repos; tauri-specta 9 crates, 1,336 repos; Tauri core has an optional specta feature.                                                                                                     | 452 crate dependents, 3,557 GitHub repos, 23.6 M downloads; clear leader.                                                                                                                                                                                |
| Security hygiene                        | No advisories, no SECURITY.md; trusted publishing, SHA-pinned actions (best of the two); macros clean.                                                                                                                                    | No advisories, no SECURITY.md; manual token publishing; macros clean.                                                                                                                                                                                    |
| Dependency footprint                    | +9 crates, 2 third-party (one with an unmaintained advisory).                                                                                                                                                                             | +3 crates, 1 third-party.                                                                                                                                                                                                                                |
| Continuity risk if the maintainer stops | **High and visible** [I]: one person, exact cross-pins mean a stalled specta blocks tauri-specta, and Tauri 3 needs a new line. Mitigant: a growing second committer, Tauri's own optional dependency creating pressure to keep it alive. | **Medium** [I]: stalling is already partly happening (release lag), but the derive surface is small and slow-moving; a fork or a handover to the Aleph-Alpha org is plausible because the repo is in a company org and owner rights could be reassigned. |
| Cost to migrate away                    | Medium to high for tauri-specta (macros on every command, generated runtime in bindings, event naming); lower for types-only specta.                                                                                                      | Low: derive attributes plus committed `.ts` files; leaving means deleting `#[ts(...)]` and keeping or hand-maintaining the generated files.                                                                                                              |

## 6. Verdict and caveats

**Verdict**: both are trustworthy in the narrow supply-chain sense (public, long-lived, MIT, no advisories, no hostile build behaviour, small footprints). The honest difference is **maintenance model**, not integrity:

- specta stack = one prolific, publicly known maintainer closely tied to the Tauri org, strong release hygiene, but no stability promise and heavy churn. The tauri-specta maintainer's own words recommend exact pins. Continuity depends on one person.
- ts-rs = the more widely used and more conservative library with the thinner current stewardship: release rights sit with a single part-time individual, active merging with someone else, and unreleased fixes.

For Writer's current decision (types only, bindings committed and diff-tested), keeping `ts-rs` is consistent with this review. [I] Confidence: moderate-high that neither choice introduces a supply-chain risk worth blocking on; moderate that ts-rs is the lower-risk choice today (it rests on stable semver and cheap exit, against a worrying release lag). Suggested guardrails if the ADR is accepted: pin `ts-rs = "=12.0.1"` and review bumps; add a CI check that `ts-rs` and `ts-rs-macros` have a single resolved version; treat "no ts-rs release for 12 months" as an additional revisit trigger next to the existing `tauri-specta` stable trigger; re-run this review when `tauri-specta` leaves rc status.

**Unverified / limits**

- Crates.io owner-change history and who has publish rights outside the owner list: not visible via the public API.
- Whether Aleph Alpha uses ts-rs internally, and who maintains ts-rs on their behalf: not found. KittyCAD/Zoo use is inferred from crate names only.
- Median response times are a crude sample (15 items per repo, "close" counted as a response).
- RustSec was checked by directory lookup, not by `cargo audit`; the dependency tree is for macOS host, default features, and excludes dev-dependencies; I did not audit source code for subtle bugs beyond the build/proc-macro/file-I/O grep.
- I did not read the Tauri v2 documentation site pages beyond repository searches and the blog source; GitHub code search hit a rate limit before some lookups finished.
- Nothing here evaluates the people beyond what their public profiles and commit history show.
