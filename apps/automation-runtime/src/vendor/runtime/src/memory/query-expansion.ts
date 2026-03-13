const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "get",
  "give",
  "had",
  "has",
  "have",
  "help",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "just",
  "later",
  "me",
  "my",
  "now",
  "of",
  "on",
  "or",
  "our",
  "please",
  "recently",
  "show",
  "something",
  "stuff",
  "tell",
  "that",
  "the",
  "their",
  "them",
  "there",
  "these",
  "they",
  "thing",
  "this",
  "those",
  "to",
  "today",
  "tomorrow",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "with",
  "would",
  "yesterday",
  "you",
  "your",
]);

function normalizeToken(token: string): string {
  return token.toLocaleLowerCase().normalize("NFKC").trim();
}

export function isQueryStopWordToken(token: string): boolean {
  const normalized = normalizeToken(token);
  return normalized.length === 0 || STOP_WORDS.has(normalized);
}

export function extractKeywords(text: string, opts?: { maxKeywords?: number }): string[] {
  const maxKeywords = Math.max(1, opts?.maxKeywords ?? 12);
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const rawToken of text.split(/[^\p{L}\p{N}_./:-]+/u)) {
    const token = normalizeToken(rawToken);
    if (!token || token.length <= 1 || isQueryStopWordToken(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    keywords.push(token);
    if (keywords.length >= maxKeywords) {
      break;
    }
  }
  return keywords;
}
