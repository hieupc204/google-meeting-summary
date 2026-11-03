// Auth headers for the configured AI endpoint. Anthropic's native routes
// (e.g. /v1/models) reject requests without `x-api-key` + `anthropic-version`;
// its OpenAI-compatible /chat/completions also accepts these, so we send both.
export function buildAIHeaders(endpoint: string, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (/(^|\.)anthropic\.com/i.test(safeHost(endpoint))) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }
  return headers;
}

function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return '';
  }
}
