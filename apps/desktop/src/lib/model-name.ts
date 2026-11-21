/** `claude-opus-5-5-20260101` to `Opus 5.5`; anything else is shown as is. The one place a model id
 *  becomes a display name: the agent's model chip and the Git history's agent versions. */
export function prettyModelId(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(id);
  if (!m) return id;
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}
