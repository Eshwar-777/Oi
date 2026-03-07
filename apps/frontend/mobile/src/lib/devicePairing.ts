export interface PairingInput {
  pairingId: string;
  code: string;
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

export function parsePairingInput(raw: string): PairingInput | null {
  const value = raw.trim();
  if (!value) return null;

  // Accept deep-link form: oi://pair-device?pairing_id=...&code=...
  if (value.startsWith("oi://")) {
    try {
      const url = new URL(value);
      const pairingId = (url.searchParams.get("pairing_id") || "").trim();
      const code = normalizeCode(url.searchParams.get("code") || "");
      if (pairingId && code) {
        return { pairingId, code };
      }
    } catch {
      return null;
    }
  }

  // Accept simple text format: "<pairing_id> <code>"
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return { pairingId: parts[0], code: normalizeCode(parts[1]) };
  }

  return null;
}
