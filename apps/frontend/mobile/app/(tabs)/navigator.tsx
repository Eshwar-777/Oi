import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useFocusEffect } from "expo-router";
import {
  MobileScreen,
  SecondaryButton,
  SectionHeader,
  StatusChip,
  SurfaceCard,
  mobileTheme,
} from "@oi/design-system-mobile";

import { fetchWithTimeout, getApiBaseUrl } from "@/lib/api";
import { getAuthHeaders } from "@/lib/authHeaders";

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
  const res = await fetchWithTimeout(
    `${api}/browser/agent/history?limit=${encodeURIComponent(String(limit))}`,
    {
      headers: await getAuthHeaders(),
    },
  );
  const body = await res.json().catch(() => ({ items: [] }));
  if (!res.ok) {
    const detail =
      typeof body?.detail === "string" ? body.detail : "Failed to fetch navigator history";
    throw new Error(detail);
  }
  return Array.isArray(body?.items) ? (body.items as NavigatorRunHistoryItem[]) : [];
}

function prettyTime(value?: string) {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

function statusTone(status: string): "brand" | "success" | "warning" | "danger" | "neutral" {
  const normalized = status.toLowerCase();
  if (normalized === "completed") return "success";
  if (normalized === "blocked") return "warning";
  if (normalized === "stopped") return "neutral";
  if (normalized === "planning" || normalized === "running") return "brand";
  return "danger";
}

export default function NavigatorScreen() {
  const [items, setItems] = useState<NavigatorRunHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [filter, setFilter] = useState<
    "all" | "completed" | "failed" | "blocked" | "stopped"
  >("all");
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
    filter === "all" ? items : items.filter((run) => String(run.status || "").toLowerCase() === filter);

  return (
    <MobileScreen scrollable contentContainerStyle={styles.content}>
      <SectionHeader
        eyebrow="Navigator"
        title="Recent runs"
        description="Navigator history is now presented through shared mobile cards, chips, and section headers."
      />

      <View style={styles.actionsRow}>
        <View style={styles.actionButton}>
          <SecondaryButton onPress={() => void loadRuns()} loading={loading}>
            Refresh
          </SecondaryButton>
        </View>
      </View>

      {errorMessage ? (
        <SurfaceCard>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </SurfaceCard>
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
              <Text style={[styles.filterChipText, active ? styles.filterChipTextActive : null]}>
                {value}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {loading && items.length === 0 ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={mobileTheme.colors.primary} />
        </View>
      ) : null}

      {!loading && items.length === 0 ? (
        <SurfaceCard>
          <Text style={styles.emptyText}>No navigator runs yet.</Text>
        </SurfaceCard>
      ) : null}

      {!loading && items.length > 0 && filteredItems.length === 0 ? (
        <SurfaceCard>
          <Text style={styles.emptyText}>No runs match this filter.</Text>
        </SurfaceCard>
      ) : null}

      {filteredItems.map((run) => {
        const stepCount = Array.isArray(run.steps_executed) ? run.steps_executed.length : 0;
        const isExpanded = Boolean(expandedRunIds[run.run_id]);

        return (
          <SurfaceCard key={run.run_id} style={styles.runCard}>
            <View style={styles.runHeader}>
              <Text style={styles.promptText}>
                {run.prompt || run.rewritten_prompt || "Navigator task"}
              </Text>
              <StatusChip
                label={String(run.status || "failed")}
                tone={statusTone(String(run.status || "failed"))}
              />
            </View>

            <Text style={styles.metaText}>
              {stepCount} step{stepCount === 1 ? "" : "s"} · {prettyTime(run.created_at)}
            </Text>

            {run.message ? <Text style={styles.messageText}>{run.message}</Text> : null}

            {stepCount > 0 ? (
              <Pressable
                style={styles.timelineToggle}
                onPress={() =>
                  setExpandedRunIds((current) => ({
                    ...current,
                    [run.run_id]: !current[run.run_id],
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
                {run.steps_executed.map((rawStep, index) => {
                  const step = (rawStep ?? {}) as Record<string, unknown>;
                  const stepStatus = String(step.status || "waiting");
                  const screenshot =
                    typeof step.screenshot === "string" && step.screenshot ? step.screenshot : "";
                  const description =
                    String(step.description || "").trim() ||
                    String(step.action || "").trim() ||
                    `Step ${index + 1}`;

                  return (
                    <View key={`${run.run_id}-${index}`} style={styles.timelineItem}>
                      <View style={styles.timelineHeader}>
                        <Text style={styles.timelineText}>{description}</Text>
                        <StatusChip label={stepStatus} tone={statusTone(stepStatus)} />
                      </View>
                      {screenshot ? (
                        <Image
                          source={{ uri: screenshot }}
                          style={styles.timelineImage}
                          resizeMode="contain"
                        />
                      ) : null}
                    </View>
                  );
                })}
              </View>
            ) : null}
          </SurfaceCard>
        );
      })}
    </MobileScreen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: mobileTheme.spacing[4],
    paddingBottom: mobileTheme.spacing[6],
  },
  actionsRow: {
    flexDirection: "row",
    justifyContent: "flex-start",
  },
  actionButton: {
    minWidth: 132,
  },
  errorText: {
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.error,
  },
  filterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: mobileTheme.spacing[2],
  },
  filterChip: {
    borderRadius: mobileTheme.radii.full,
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
    backgroundColor: mobileTheme.colors.surface,
    paddingHorizontal: mobileTheme.spacing[3],
    paddingVertical: mobileTheme.spacing[2],
  },
  filterChipActive: {
    borderColor: mobileTheme.colors.primary,
    backgroundColor: mobileTheme.colors.primarySoft,
  },
  filterChipText: {
    fontSize: mobileTheme.typography.fontSize.xs,
    color: mobileTheme.colors.textMuted,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  filterChipTextActive: {
    color: mobileTheme.colors.primaryStrong,
  },
  loadingWrap: {
    paddingVertical: mobileTheme.spacing[6],
    alignItems: "center",
  },
  emptyText: {
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.textMuted,
  },
  runCard: {
    gap: mobileTheme.spacing[2],
  },
  runHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: mobileTheme.spacing[3],
  },
  promptText: {
    flex: 1,
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.text,
    fontWeight: "700",
  },
  metaText: {
    fontSize: mobileTheme.typography.fontSize.xs,
    color: mobileTheme.colors.textMuted,
  },
  messageText: {
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.textMuted,
  },
  timelineToggle: {
    marginTop: mobileTheme.spacing[1],
  },
  timelineToggleText: {
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.primary,
    fontWeight: "700",
  },
  timelineWrap: {
    marginTop: mobileTheme.spacing[2],
    gap: mobileTheme.spacing[2],
  },
  timelineItem: {
    padding: mobileTheme.spacing[3],
    borderRadius: mobileTheme.radii.sm,
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
    backgroundColor: mobileTheme.colors.surfaceMuted,
    gap: mobileTheme.spacing[2],
  },
  timelineHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: mobileTheme.spacing[2],
  },
  timelineText: {
    flex: 1,
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.text,
  },
  timelineImage: {
    width: "100%",
    height: 220,
    borderRadius: mobileTheme.radii.sm,
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
  },
});
