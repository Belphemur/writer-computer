#!/usr/bin/env bash
# Build and test Writer on Linux from a Mac: an ubuntu:26.04 container (arm64 natively on Apple
# silicon, the same release the x86_64 CI uses). Needs Docker (Rancher Desktop's `docker` works).
#
#   scripts/linux-container.sh [check|test|vitest|rust|bundle|e2e|all|shell]    (default: all)
#
#   check    vp check
#   test     vitest then cargo (both always run); `vitest` and `rust` run one half
#   bundle   tauri build of the .deb and .rpm (WRITER_LINUX_APPIMAGE=1 adds the AppImage, whose
#            tooling linuxdeploy is downloaded from GitHub)
#   e2e      the smoke spec under xvfb, on a debug build of the app with the WebDriver server
#   shell    a bash prompt in the prepared container
#
# The checkout is read-only inside the container and synced to a work volume, so nothing here
# touches your tree. Volumes keep the Cargo and pnpm caches and the build output between runs;
# `docker volume rm writer-linux-work writer-linux-cargo writer-linux-target writer-linux-pnpm`
# starts over. Package list: scripts/linux-build-deps.txt (the same file CI installs from).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STEP="${1:-all}"
IMAGE=writer-linux-build
BASE_IMAGE="${WRITER_LINUX_IMAGE:-ubuntu:26.04}"
PNPM_VERSION="$(sed -n 's/.*"packageManager": "pnpm@\(.*\)".*/\1/p' "$ROOT_DIR/package.json")"

case "$STEP" in
  check | test | vitest | rust | bundle | e2e | all | shell) ;;
  *)
    echo "usage: $0 [check|test|vitest|rust|bundle|e2e|all|shell]" >&2
    exit 2
    ;;
esac

echo "==> image $IMAGE (from $BASE_IMAGE)"
docker build --quiet -t "$IMAGE" -f - "$ROOT_DIR/scripts" <<DOCKERFILE
FROM $BASE_IMAGE
ENV DEBIAN_FRONTEND=noninteractive
COPY linux-build-deps.txt /tmp/deps.txt
RUN apt-get update -qq \
 && xargs -a /tmp/deps.txt apt-get install -y -qq --no-install-recommends ca-certificates rsync nodejs npm rustup lld >/dev/null \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --silent pnpm@$PNPM_VERSION \
 && rustup default stable \
 && rustup component add clippy rustfmt
ENV PATH=/root/.cargo/bin:\$PATH
DOCKERFILE

read -r -d '' INNER <<'INNER_SH' || true
set -euo pipefail
step="$1"
export CARGO_TARGET_DIR=/target CARGO_TERM_COLOR=never CI=true
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-3}"
# A Docker VM with a few GB of memory: the default linker is killed linking this crate with full
# debug info, so link with lld and keep debug info out of debug and test builds.
export RUSTFLAGS="${RUSTFLAGS:--C link-arg=-fuse-ld=lld}" CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0
# AppImage tooling cannot mount FUSE in a container: extract and run instead.
export APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=1
rsync -a --delete --exclude node_modules --exclude target --exclude dist --exclude .git \
  --exclude .wrangler /src/ /work/
cd /work
pnpm config set store-dir /pnpm-store >/dev/null
pnpm install --frozen-lockfile --silent
VP=/work/node_modules/.bin/vp

do_check() { echo "==> vp check"; "$VP" check; }
do_vitest() {
  echo "==> vp test"
  # Few workers: several files run a whole `vp build`, which times out when 6 of them share a
  # small VM.
  (cd apps/desktop && VITEST_MAX_WORKERS="${VITEST_MAX_WORKERS:-2}" "$VP" test run)
}
do_rust() {
  echo "==> cargo test, clippy, fmt"
  # WRITER_CARGO_TEST_ARGS narrows the run, e.g. "--lib plugin_http" (clippy and fmt still follow).
  (cd apps/desktop/src-tauri && cargo test ${WRITER_CARGO_TEST_ARGS:-} && cargo clippy && cargo fmt --check)
}
# Both halves always run; the exit status says whether either failed.
do_test() {
  local rc=0
  do_vitest || rc=1
  do_rust || rc=1
  return $rc
}
do_bundle() {
  local targets=deb,rpm
  [ "${WRITER_LINUX_APPIMAGE:-}" = 1 ] && targets=appimage,deb,rpm
  echo "==> tauri build --bundles $targets"
  cd apps/desktop
  # The packaging is what is checked here, not the optimizer: skip the release profile's LTO
  # (fat LTO with one codegen unit does not fit a small VM and takes far longer).
  export CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
  "$VP" exec tauri build --bundles "$targets" --config '{"bundle":{"createUpdaterArtifacts":false}}'
  ls -l "$CARGO_TARGET_DIR"/release/bundle/*/
  echo "-- deb contents and scripts"
  dpkg-deb -c "$CARGO_TARGET_DIR"/release/bundle/deb/*.deb | grep -E "bin/|\.desktop"
  dpkg-deb -I "$CARGO_TARGET_DIR"/release/bundle/deb/*.deb | grep -E "postinst|prerm"
  echo "-- rpm contents and scripts"
  rpm -qlp "$CARGO_TARGET_DIR"/release/bundle/rpm/*.rpm | grep -E "bin/|\.desktop"
  rpm -qp --scripts "$CARGO_TARGET_DIR"/release/bundle/rpm/*.rpm | grep -E "writer-desktop"
}
do_e2e() {
  command -v tauri-webdriver >/dev/null || cargo install tauri-webdriver --locked
  echo "==> e2e smoke (debug build, xvfb)"
  cd apps/desktop/e2e
  WRITER_E2E_DEBUG=1 pnpm run build:app
  WRITER_E2E_DEBUG=1 xvfb-run -a -s "-screen 0 1280x900x24" pnpm run test:smoke
}

case "$step" in
  check) do_check ;;
  test) do_test ;;
  vitest) do_vitest ;;
  rust) do_rust ;;
  bundle) do_bundle ;;
  e2e) do_e2e ;;
  all)
    rc=0
    do_check || rc=1
    (do_test) || rc=1
    (do_bundle) || rc=1
    (do_e2e) || rc=1
    exit $rc
    ;;
  shell) exec bash ;;
esac
INNER_SH

TTY=()
[ "$STEP" = shell ] && TTY=(-it)
exec docker run --rm "${TTY[@]}" \
  -v "$ROOT_DIR":/src:ro \
  -v writer-linux-work:/work \
  -v writer-linux-cargo:/root/.cargo \
  -v writer-linux-target:/target \
  -v writer-linux-pnpm:/pnpm-store \
  -e WRITER_CARGO_TEST_ARGS -e WRITER_LINUX_APPIMAGE -e WRITER_E2E_DEBUG -e CARGO_BUILD_JOBS \
  "$IMAGE" bash -c "$INNER" _ "$STEP"
