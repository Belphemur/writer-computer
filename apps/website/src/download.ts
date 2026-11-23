/**
 * Which build the download button offers. Detection is a pure function of the
 * user agent so it is testable and the prerendered page (which has none) can
 * fall back to the Mac build, as the page always has.
 */

export type DownloadOs = "mac" | "linux";

/** Linux for a Linux desktop (not Android, which says "Linux" too), else Mac. */
export function detectDownloadOs(userAgent: string): DownloadOs {
  if (/android/i.test(userAgent)) return "mac";
  return /linux|x11/i.test(userAgent) ? "linux" : "mac";
}
