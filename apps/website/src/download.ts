/**
 * Which build the download button offers. Detection is a pure function of the
 * user agent so it is testable and the prerendered page (which has none) can
 * fall back to the Mac build, as the page always has.
 */

/** "other" is a machine no package is built for (ARM Linux): it is sent to the releases page. */
export type DownloadOs = "mac" | "linux" | "chromeos" | "other";

/** Release packages are x86_64 only; an ARM machine's UA says aarch64 or arm. */
const ARM = /aarch64|arm/i;

export function detectDownloadOs(userAgent: string): DownloadOs {
  // Android says "Linux" too, and its visitor is on a phone: show the Mac build as for any unknown.
  if (/android/i.test(userAgent)) return "mac";
  const desktopLinux = /linux|x11/i.test(userAgent);
  if (/CrOS/.test(userAgent)) return ARM.test(userAgent) ? "other" : "chromeos";
  if (desktopLinux) return ARM.test(userAgent) ? "other" : "linux";
  return "mac";
}
