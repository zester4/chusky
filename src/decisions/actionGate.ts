/** Conservative capability gate: only unmistakable pleasantries are compact. */
export function isClearlyConversational(query: string, recentContext = ""): boolean {
  const value = query.trim().replace(/\s+/g, " ");
  if (!value || value.split(" ").length > 10) return false;
  if (/\b(?:yes|yeah|yep|do it|go ahead|continue|approve|retry|proceed|ship it|send it|okay do that)\b/i.test(value)) return false;
  if (/[?]/.test(value) && !/^how are you\b/i.test(value)) return false;
  if (/\b(?:tool|approval|approved|pending|mission|task|calendar|email|slack|gmail|notion|meeting|call|send|buy|pay|schedule|remind|continue)\b/i.test(recentContext)) return false;
  return /^(?:hey|hi|hello|yo|thanks|thank you|thx|good morning|good afternoon|good evening|good night|how are you|how's it going|okay|ok|cool|got it|sounds good|nice|great|lol|haha|bye|goodbye|see you|take care|you're welcome|welcome)[!. ]*$/i.test(value);
}
