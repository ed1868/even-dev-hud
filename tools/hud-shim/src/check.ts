import { randomUUID } from 'node:crypto';
import { config } from './config.ts';
import { db } from './db.ts';

/**
 * Fact-check engine.
 *
 * Takes a transcript (raw text from Whisper or typed), searches the
 * `context_snippets` table for matching private context, and returns
 * grounded matches or "no match."
 *
 * This deliberately does NOT make a verdict call (TRUE / FALSE). It finds
 * evidence and shows it. The user decides what it means. That is the whole
 * difference from Conversate, which guesses when it can't ground.
 */

export type CheckMatch = {
  id: string;
  text: string;
  source: string;
  channel: string | null;
  author: string | null;
  ts: number;
  score: number;
};

export type CheckResult = {
  id: string;
  transcript: string;
  claim: string | null;
  matches: CheckMatch[];
  searched: string[];
  checkedAt: number;
};

/**
 * Extract keywords from a transcript for search. Strips common stop words and
 * short fragments to improve match quality.
 */
function extractKeywords(text: string): string[] {
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'must', 'need',
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it',
    'they', 'them', 'their', 'this', 'that', 'these', 'those',
    'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'up',
    'about', 'into', 'through', 'during', 'before', 'after', 'above',
    'below', 'between', 'and', 'but', 'or', 'nor', 'not', 'no', 'so',
    'if', 'then', 'than', 'too', 'very', 'just', 'also',
    'what', 'when', 'where', 'who', 'which', 'how', 'why',
    'said', 'say', 'says', 'think', 'know', 'like', 'right', 'yeah',
    'yes', 'no', 'ok', 'okay', 'well', 'got', 'get', 'going', 'go',
    'um', 'uh', 'ah', 'oh',
  ]);

  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Score a snippet against keywords. Higher = more keywords matched.
 * Returns 0 if no keywords match.
 */
function scoreSnippet(snippetText: string, keywords: string[]): number {
  const lower = snippetText.toLowerCase();
  let matched = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) matched++;
  }
  // Normalize to 0–1 range
  return keywords.length > 0 ? matched / keywords.length : 0;
}

/**
 * Transcribe audio using OpenAI's Whisper API.
 *
 * Accepts base64-encoded audio (WAV or raw PCM). Returns the transcript text.
 * Returns null if Whisper is not configured.
 */
export async function transcribe(audioBase64: string): Promise<string | null> {
  if (!config.whisper.apiKey) return null;

  // Convert base64 to a Blob with WAV content type
  const audioBuffer = Buffer.from(audioBase64, 'base64');
  const blob = new Blob([audioBuffer], { type: 'audio/wav' });

  const form = new FormData();
  form.append('file', blob, 'audio.wav');
  form.append('model', config.whisper.model);
  form.append('response_format', 'text');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.whisper.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Whisper ${res.status}: ${errText}`);
  }

  const transcript = await res.text();
  return transcript.trim() || null;
}

/**
 * Search context_snippets for text matching the given keywords.
 *
 * Uses SQLite LIKE for keyword search. This is the Phase 1 approach —
 * fast, simple, no embeddings. Good enough when the context contains the
 * actual words that were spoken.
 */
function searchContext(keywords: string[], limit = 10): CheckMatch[] {
  if (keywords.length === 0) return [];

  // Fetch recent snippets and score them in memory. SQLite's LIKE is fast
  // enough for < 10k rows, and scoring in memory lets us rank by keyword
  // overlap rather than just first-match.
  const rows = db()
    .prepare(
      `SELECT id, source, channel, author, text, ts
       FROM context_snippets
       ORDER BY ts DESC
       LIMIT 5000`,
    )
    .all() as unknown as Array<{
    id: string;
    source: string;
    channel: string | null;
    author: string | null;
    text: string;
    ts: number;
  }>;

  const scored: CheckMatch[] = [];
  for (const row of rows) {
    const score = scoreSnippet(row.text, keywords);
    if (score > 0) {
      scored.push({
        id: row.id,
        text: row.text,
        source: row.source,
        channel: row.channel,
        author: row.author,
        ts: row.ts,
        score,
      });
    }
  }

  // Sort by score descending, then recency
  scored.sort((a, b) => b.score - a.score || b.ts - a.ts);
  return scored.slice(0, limit);
}

/**
 * Run a fact check against private context.
 *
 * Accepts either:
 *   - `{ text: string }` — pre-transcribed text
 *   - `{ audio: string }` — base64-encoded audio to transcribe first
 *
 * Returns matches from private context, or an empty array with "no match."
 */
export async function runCheck(input: { text?: string; audio?: string }): Promise<CheckResult> {
  const id = randomUUID();
  const checkedAt = Date.now();

  // Step 1: Get the transcript
  let transcript: string;
  if (input.text) {
    transcript = input.text;
  } else if (input.audio) {
    const result = await transcribe(input.audio);
    if (!result) throw new Error('Whisper not configured — set OPENAI_API_KEY');
    transcript = result;
  } else {
    throw new Error('either text or audio is required');
  }

  // Step 2: Extract keywords
  const keywords = extractKeywords(transcript);

  // Step 3: Search context
  const matches = searchContext(keywords, 5);

  // Step 4: Determine which sources were searched
  const searched: string[] = [];
  const snippetSources = db()
    .prepare('SELECT DISTINCT source FROM context_snippets')
    .all() as unknown as { source: string }[];
  for (const s of snippetSources) searched.push(s.source);
  if (searched.length === 0) searched.push('(none indexed)');

  // Step 5: Record the check
  const topMatch = matches[0]
    ? JSON.stringify({
        text: matches[0].text.slice(0, 200),
        source: matches[0].source,
        channel: matches[0].channel,
        ts: matches[0].ts,
        score: matches[0].score,
      })
    : null;

  db()
    .prepare(
      `INSERT INTO fact_checks (id, transcript, claim, match_count, top_match, sources, checked_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(id, transcript, null, matches.length, topMatch, searched.join(','), checkedAt);

  return { id, transcript, claim: null, matches, searched, checkedAt };
}

/**
 * Get recent fact checks for the glasses history view.
 */
export function recentChecks(limit = 10): Array<{
  id: string;
  transcript: string;
  claim: string | null;
  match_count: number;
  top_match: string | null;
  checked_at: number;
}> {
  return db()
    .prepare(
      `SELECT id, transcript, claim, match_count, top_match, checked_at
       FROM fact_checks ORDER BY checked_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as Array<{
    id: string;
    transcript: string;
    claim: string | null;
    match_count: number;
    top_match: string | null;
    checked_at: number;
  }>;
}
