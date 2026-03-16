const BROWSER_CORE_SKILLS_PROMPT = [
  "Browser-core automation guidance:",
  "- Prefer browser snapshots before acting on the page.",
  "- Use stable refs from the latest snapshot whenever possible.",
  "- If the target UI is already open, continue from that surface instead of restarting the flow.",
  "- After a mutating action, re-observe and verify the visible state changed before considering the step complete.",
  "- For dynamic forms, recover from the latest good foreground observation before widening scope.",
].join("\n");

export function resolveBrowserCoreSkillsPrompt(): string {
  return BROWSER_CORE_SKILLS_PROMPT;
}
