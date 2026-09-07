/**
 * Follow-up drafts (src/lib/track/followups.ts) mark their llm_summary with
 * this prefix; first-contact drafts do not. Draft & Send, the sidebar count
 * and the follow-up badge all read the same rule.
 */
export const FOLLOW_UP_PREFIX = "follow_up";

export function isFollowUpDraft(draft: { llm_summary: string | null } | null | undefined): boolean {
  return draft?.llm_summary?.startsWith(FOLLOW_UP_PREFIX) ?? false;
}
