import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useFocusEffect } from "expo-router";

import { fetchWithTimeout, getApiBaseUrl } from "@/lib/api";
import { getAuthHeaders } from "@/lib/authHeaders";
import { mobileTheme } from "@/theme";

interface NavigatorRunHistoryItem {
  run_id: string;
  prompt?: string;
  rewritten_prompt?: string;
  status?: string;
  message?: string;
  created_at?: string;
  steps_executed?: Array<Record<string, unknown>>;
}

async function listNavigatorRuns(limit = 30): Promise<NavigatorRunHistoryItem[]> {
  const api = getApiBaseUrl();
  const res = await fetchWithTimeout(`${api}/browser/agent/history?limit=${encodeURIComponent(String(limit))}`, {
    headers: await getAuthHeaders(),
  });
  const body = await res.json().catch(() => ({ items: [] }));
  if (!res.ok) {
    const detail = typeof body?.detail === "string" ? body.detail : "Failed to fetch navigator history";
    throw new Error(detail);
  }
  return Array.isArray(body?.items) ? (body.items as NavigatorRunHistoryItem[]) : [];
}

function prettyTime(value?: string): string {
  if (!value) return "";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Date(ts).toLocaleString();
}

function statusTone(status: string): { text: string; bg: string; fg: string } {
  const s = status.toLowerCase();
  if (s === "completed") return { text: "Completed", bg: "#EAF8EF", fg: "#1E7A3A" };
  if (s === "blocked") return { text: "Blocked", bg: "#FFF6E6", fg: "#9C6500" };
  if (s === "stopped") return { text: "Stopped", bg: "#F0F0F0", fg: "#555555" };
  if (s === "planning" || s === "running") return { text: "Running", bg: "#F7EBEF", fg: "#751636" };
  return { text: "Failed", bg: "#FDECEC", fg: "#B42318" };
}

export default function NavigatorScreen() {
  const [items, setItems] = useState<NavigatorRunHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [filter, setFilter] = useState<"all" | "completed" | "failed" | "blocked" | "stopped">("all");
  const [expandedRunIds, setExpandedRunIds] = useState<Record<string, boolean>>({});

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setErrorMessage("");
    try {
      const runs = await listNavigatorRuns(30);
      setItems(runs);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to load navigator history");
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadRuns();
    }, [loadRuns]),
  );

  const filteredItems =
    filter === "all"
      ? items
      : items.filter((run) => String(run.status || "").toLowerCase() === filter);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Navigator</Text>
        <Pressable style={styles.refreshButton} onPress={() => void loadRuns()}>
          <Text style={styles.refreshText}>{loading ? "Refreshing..." : "Refresh"}</Text>
        </Pressable>
      </View>

      <Text style={styles.subtitle}>
        Recent navigator tasks from your account. This syncs across linked devices.
      </Text>

      {errorMessage ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      ) : null}

      {loading && items.length === 0 ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={mobileTheme.colors.primary} />
        </View>
      ) : null}

      <View style={styles.filterRow}>
        {(["all", "completed", "failed", "blocked", "stopped"] as const).map((value) => {
          const active = filter === value;
          return (
            <Pressable
              key={value}
              style={[styles.filterChip, active ? styles.filterChipActive : null]}
              onPress={() => setFilter(value)}
            >
              <Text style={[styles.filterChipText, active ? styles.filterChipTextActive : null]}>{value}</Text>
            </Pressable>
          );
        })}
      </View>

      {!loading && items.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>No navigator runs yet.</Text>
        </View>
      ) : null}

      {!loading && items.length > 0 && filteredItems.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>No runs match this filter.</Text>
        </View>
      ) : null}

      {filteredItems.map((run) => {
        const status = statusTone(String(run.status || "failed"));
        const stepCount = Array.isArray(run.steps_executed) ? run.steps_executed.length : 0;
        const isExpanded = Boolean(expandedRunIds[run.run_id]);
        return (
          <View key={run.run_id} style={styles.card}>
            <View style={styles.cardTop}>
              <Text style={styles.promptText} numberOfLines={2}>
                {run.prompt || run.rewritten_prompt || "Navigator task"}
              </Text>
              <View style={[styles.badge, { backgroundColor: status.bg }]}>
                <Text style={[styles.badgeText, { color: status.fg }]}>{status.text}</Text>
              </View>
            </View>
            <Text style={styles.metaText}>
              {stepCount} step{stepCount === 1 ? "" : "s"} · {prettyTime(run.created_at)}
            </Text>
            {run.message ? (
              <Text style={styles.messageText} numberOfLines={2}>
                {run.message}
              </Text>
            ) : null}
            {stepCount > 0 ? (
              <Pressable
                style={styles.timelineToggle}
                onPress={() =>
                  setExpandedRunIds((prev) => ({
                    ...prev,
                    [run.run_id]: !prev[run.run_id],
                  }))
                }
              >
                <Text style={styles.timelineToggleText}>
                  {isExpanded ? "Hide timeline" : "Show timeline"}
                </Text>
              </Pressable>
            ) : null}
            {isExpanded && Array.isArray(run.steps_executed) ? (
              <View style={styles.timelineWrap}>
                {run.steps_executed.map((rawStep, idx) => {
                  const step = (rawStep ?? {}) as Record<string, unknown>;
                  const stepStatus = String(step.status || "waiting").toLowerCase();
                  const screenshot =
                    typeof step.screenshot === "string" && step.screenshot ? step.screenshot : "";
                  const description =
                    String(step.description || "").trim() ||
                    String(step.action || "").trim() ||
                    `Step ${idx + 1}`;
                  return (
                    <View key={`${run.run_id}-step-${idx}`} style={styles.timelineRow}>
                      <Text style={styles.timelineText} numberOfLines={2}>{description}</Text>
                      <Text style={styles.timelineStatus}>{stepStatus}</Text>
                      {screenshot ? <Image source={{ uri: screenshot }} style={styles.timelineImage} resizeMode="contain" /> : null}
                    </View>
                  );
                })}
              </View>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: mobileTheme.colors.bg },
  content: { padding: 16, paddingBottom: 28 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: 24, fontWeight: "700", color: mobileTheme.colors.text },
  refreshButton: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: mobileTheme.colors.surface,
  },
  refreshText: { color: mobileTheme.colors.primary, fontWeight: "600", fontSize: 13 },
  subtitle: { marginTop: 8, marginBottom: 12, fontSize: 13, color: mobileTheme.colors.textMuted },
  errorBox: {
    backgroundColor: "#FDECEC",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#F7C6C7",
    padding: 10,
    marginBottom: 10,
  },
  errorText: { color: "#B42318", fontSize: 13 },
  loadingWrap: { paddingVertical: 24, alignItems: "center" },
  filterRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  filterChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
    backgroundColor: mobileTheme.colors.surface,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  filterChipActive: {
    borderColor: mobileTheme.colors.primary,
    backgroundColor: mobileTheme.colors.primarySoft,
  },
  filterChipText: { fontSize: 12, color: mobileTheme.colors.textMuted, fontWeight: "600" },
  filterChipTextActive: { color: mobileTheme.colors.primary },
  emptyCard: {
    backgroundColor: mobileTheme.colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
    padding: 14,
  },
  emptyText: { color: mobileTheme.colors.textMuted, fontSize: 14 },
  card: {
    backgroundColor: mobileTheme.colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
    padding: 12,
    marginBottom: 10,
  },
  cardTop: { flexDirection: "row", gap: 8, alignItems: "flex-start", justifyContent: "space-between" },
  promptText: { flex: 1, fontSize: 14, color: mobileTheme.colors.text, fontWeight: "600" },
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4 },
  badgeText: { fontSize: 11, fontWeight: "700" },
  metaText: { marginTop: 6, fontSize: 12, color: "#7D6D72" },
  messageText: { marginTop: 6, fontSize: 12, color: mobileTheme.colors.textMuted },
  timelineToggle: { marginTop: 6 },
  timelineToggleText: { fontSize: 12, color: mobileTheme.colors.primary, fontWeight: "600" },
  timelineWrap: { marginTop: 8, borderTopWidth: 1, borderTopColor: "#EEE4E7", paddingTop: 8, gap: 6 },
  timelineRow: {
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: mobileTheme.colors.surface,
  },
  timelineText: { fontSize: 12, color: mobileTheme.colors.text, marginBottom: 3 },
  timelineStatus: { fontSize: 11, color: mobileTheme.colors.textMuted, textTransform: "uppercase", fontWeight: "700" },
  timelineImage: {
    width: "100%",
    height: 140,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
    backgroundColor: mobileTheme.colors.bg,
    marginTop: 6,
  },
});
