const SYSTEM_PROMPT = `You are a sports card identification assistant. You will be shown one or
more photos of a single physical trading card (front and/or back). Identify
what is visible and respond with ONLY a JSON object (no prose, no markdown
fences) matching exactly this shape:

{
  "player": string | null,
  "sport": "MLB" | "NBA" | "NFL" | "Soccer" | null,
  "year": string | null,
  "brand": string | null,        // e.g. "Topps Chrome", "Bowman", "Panini Prizm"
  "parallel": string | null,     // e.g. "Refractor", "Silver Prizm", "Base"
  "card_number": string | null,  // e.g. "BCP-123"
  "is_rookie": boolean,
  "serial_number": string | null,   // e.g. "23/99", null if not numbered/no visible serial
  "is_autograph": boolean,
  "is_graded": boolean,
  "grading_company": string | null, // e.g. "PSA", "BGS", null if not graded/not visible
  "grade": string | null,           // e.g. "10", null if not graded/not visible
  "condition_notes": string | null, // brief notes on visible condition (corners, centering, surface) if ungraded
  "confidence": "high" | "medium" | "low",
  "uncertain_fields": string[]  // field names you're not confident about
}

Only report what you can actually see. Use null rather than guessing when a
photo doesn't show something clearly (e.g. the back isn't shown so you can't
confirm the card number). Be conservative about is_autograph and
serial_number — only mark true/non-null if there's a visible signature or a
visible serial numbering stamp respectively.`;

export function buildAnthropicRequest(images) {
  const content = [
    { type: "text", text: "Identify this trading card from the photo(s) below." },
    ...images.map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.media_type, data: img.data },
    })),
  ];

  return {
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  };
}

// Strips a ```json ... ``` or ``` ... ``` fence if the model wrapped its
// output in one, despite being asked not to — models do this often enough
// that relying on prompt compliance alone isn't reliable.
function stripCodeFence(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : trimmed;
}

export function parseAnthropicResponse(json) {
  const block = (json.content || []).find((b) => b.type === "text");
  if (!block) {
    throw new Error("No text response from card analysis model");
  }

  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(block.text));
  } catch (e) {
    throw new Error("Card analysis model returned non-JSON output: " + block.text.slice(0, 200));
  }

  return {
    player: parsed.player ?? null,
    sport: parsed.sport ?? null,
    year: parsed.year ?? null,
    brand: parsed.brand ?? null,
    parallel: parsed.parallel ?? null,
    card_number: parsed.card_number ?? null,
    is_rookie: Boolean(parsed.is_rookie),
    serial_number: parsed.serial_number ?? null,
    is_autograph: Boolean(parsed.is_autograph),
    is_graded: Boolean(parsed.is_graded),
    grading_company: parsed.grading_company ?? null,
    grade: parsed.grade ?? null,
    condition_notes: parsed.condition_notes ?? null,
    confidence: parsed.confidence ?? "low",
    uncertain_fields: Array.isArray(parsed.uncertain_fields) ? parsed.uncertain_fields : [],
  };
}

export async function analyzeCard(images, apiKey, fetchImpl = fetch) {
  const resp = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(buildAnthropicRequest(images)),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Anthropic API error ${resp.status}: ${text.slice(0, 300)}`);
  }

  const json = await resp.json();
  return parseAnthropicResponse(json);
}
