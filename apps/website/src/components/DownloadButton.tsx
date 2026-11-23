import { useEffect, useState } from "react";

import { type DownloadOs, detectDownloadOs } from "../download";
import type { DownloadAssets } from "../latest-release";
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

type Props = { os: DownloadOs; assets: DownloadAssets; onDownload: () => void };

/** The download button for `os`. */
export function DownloadButton({ os, assets, onDownload }: Props) {
  return os === "mac" ? (
    <a className="download" href={assets.mac} onClick={onDownload}>
      <AppleGlyph size={20} />
      <span>Download for macOS</span>
    </a>
  ) : (
    <a className="download" href={assets.linux.appimage} onClick={onDownload}>
      <LinuxGlyph size={20} />
      <span>Download for Linux</span>
    </a>
  );
}

/** Plain links to the other builds, under the button. */
export function OtherDownloads({ os, assets, onDownload }: Props) {
  const { linux } = assets;
  const links =
    os === "mac"
      ? [
          ["AppImage", linux.appimage],
          [".deb", linux.deb],
          [".rpm", linux.rpm],
        ]
      : [
          [".deb", linux.deb],
          [".rpm", linux.rpm],
          ["macOS", assets.mac],
        ];
  return (
    <p className="download-others">
      {os === "mac" ? "Linux:" : "Also:"}{" "}
      {links.map(([label, href], i) => (
        <span key={label}>
          {i > 0 && ", "}
          <a href={href} onClick={onDownload}>
            {label}
          </a>
        </span>
      ))}
    </p>
  );
}
