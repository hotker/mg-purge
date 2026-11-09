// chatUrl builds the chat-completions endpoint from a base that may or may not
// already end in /v1, so http://host:3425, http://host:3425/, and http://host/v1
// all resolve to .../v1/chat/completions (never /v1/v1/...).
export function chatUrl(base) {
  const b = String(base || "").replace(/\/+$/, "")
  return /\/v1$/.test(b) ? b + "/chat/completions" : b + "/v1/chat/completions"
}
