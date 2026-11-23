import { useEffect, useState } from "react";

import { type DownloadOs, detectDownloadOs } from "../download";
import type { DownloadAssets, PackageId } from "../release-assets";
import { AppleGlyph, LinuxGlyph } from "./Mark";

/**
 * The visitor's OS. Starts on "mac" (what the prerendered page shows) and
 * switches after mount, so the document hydrates without a mismatch.
 */
export function useDownloadOs(): DownloadOs {
  const [os, setOs] = useState<DownloadOs>("mac");
  useEffect(() => setOs(detectDownloadOs(navigator.userAgent)), []);
  return os;
}

type Package = {
  id: PackageId;
  /** The OS whose button this package is; none for a package that is only ever a link. */
  os?: DownloadOs;
  /** Its name in the links under the button. */
  label: string;
  /** The button's text when it is the button. */
  primary: string;
  glyph: typeof AppleGlyph;
};

/**
 * Every package the page offers, in the order of the links. The button is the package whose `os`
 * is the visitor's, the links are the others; a new package is one entry here (and one in
 * `apps/desktop/shared/release.json`).
 */
export const PACKAGES: Package[] = [
  {
    id: "appimage",
    os: "linux",
    label: "AppImage",
    primary: "Download for Linux",
    glyph: LinuxGlyph,
  },
  {
    id: "deb",
    os: "chromeos",
    label: ".deb",
    primary: "Download .deb for ChromeOS",
    glyph: LinuxGlyph,
  },
  { id: "rpm", label: ".rpm", primary: "Download .rpm", glyph: LinuxGlyph },
  { id: "mac", os: "mac", label: "macOS", primary: "Download for macOS", glyph: AppleGlyph },
];

type Props = { os: DownloadOs; assets: DownloadAssets; onDownload: () => void };

/** The download button for `os`; a machine with no package goes to the releases page. */
export function DownloadButton({ os, assets, onDownload }: Props) {
  const pkg = PACKAGES.find((p) => p.os === os);
  if (!pkg) {
    return (
      <a className="download" href={assets.releases} onClick={onDownload}>
        <LinuxGlyph size={20} />
        <span>See all downloads</span>
      </a>
    );
  }
  const Glyph = pkg.glyph;
  return (
    <a className="download" href={assets[pkg.id]} onClick={onDownload}>
      <Glyph size={20} />
      <span>{pkg.primary}</span>
    </a>
  );
}

/** Plain links to the other builds, under the button (none where the button is the releases page). */
export function OtherDownloads({ os, assets, onDownload }: Props) {
  if (!PACKAGES.some((p) => p.os === os)) return null;
  const links = PACKAGES.filter((p) => p.os !== os);
  return (
    <p className="download-others">
      {os === "mac" ? "Linux:" : "Also:"}{" "}
      {links.map(({ id, label }, i) => (
        <span key={id}>
          {i > 0 && ", "}
          <a href={assets[id]} onClick={onDownload}>
            {label}
          </a>
        </span>
      ))}
    </p>
  );
}
