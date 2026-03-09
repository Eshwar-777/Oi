import { useEffect, useState } from "react";
import {
  Box,
  Stack,
  Typography,
} from "@mui/material";
import {
  EmptyStateCard,
  SectionHeader,
  StatusPill,
  SurfaceCard,
} from "@oi/design-system-web";
import { listAutomationEngineAnalytics, listRuntimeIncidentAnalytics } from "@/api/analytics";
import type { AutomationEngineAnalyticsItem, RuntimeIncidentAnalyticsItem } from "@/domain/automation";
import { useAssistant } from "@/features/assistant/AssistantContext";

export function SchedulesPage() {
  const { schedules } = useAssistant();
  const [analytics, setAnalytics] = useState<AutomationEngineAnalyticsItem[]>([]);
  const [incidentAnalytics, setIncidentAnalytics] = useState<RuntimeIncidentAnalyticsItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([listAutomationEngineAnalytics(), listRuntimeIncidentAnalytics()])
      .then(([engineItems, incidentItems]) => {
        if (!cancelled) {
          setAnalytics(engineItems);
          setIncidentAnalytics(incidentItems);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Stack spacing={3}>
      <SectionHeader
        eyebrow="Engine analytics"
        title="Agent Browser automation"
        description="Track reliability and intervention rates for the single browser automation substrate used by the product."
      />

      {analytics.length > 0 ? (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" },
            gap: 2,
          }}
        >
          {analytics.map((item) => (
            <SurfaceCard
              key={item.automation_engine}
              eyebrow="Engine"
              title={item.automation_engine.replace("_", " ")}
              subtitle={`${item.total_runs} total runs`}
            >
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                  <StatusPill label={`Success ${(item.success_rate * 100).toFixed(0)}%`} tone="success" />
                  <StatusPill label={`Fail ${(item.failure_rate * 100).toFixed(0)}%`} tone="danger" />
                  <StatusPill label={`Human ${(item.human_pause_rate * 100).toFixed(0)}%`} tone="warning" />
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  Avg duration: {item.avg_duration_seconds != null ? `${item.avg_duration_seconds.toFixed(1)}s` : "n/a"}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Runtime split: {item.server_runner_runs} server / {item.local_runner_runs} local
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Completed: {item.completed_runs} · Failed: {item.failed_runs} · Human pauses: {item.human_paused_runs}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Last run: {item.last_run_at ? new Date(item.last_run_at).toLocaleString() : "No recent runs"}
                </Typography>
              </Stack>
            </SurfaceCard>
          ))}
        </Box>
      ) : null}

      <SectionHeader
        eyebrow="Runtime incidents"
        title="Where automation gets blocked"
        description="Track which incident classes and sites are forcing human takeover or runtime reconciliation."
      />

      {incidentAnalytics.length > 0 ? (
        <Stack spacing={2}>
          {incidentAnalytics.slice(0, 8).map((item) => (
            <SurfaceCard
              key={`${item.incident_code}-${item.site}`}
              eyebrow="Incident"
              title={item.incident_code.replaceAll("_", " ")}
              subtitle={`${item.site} · ${item.total_runs} runs`}
            >
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                  <StatusPill label={item.category.replace("_", " ")} tone="warning" />
                  <StatusPill label={`Human ${item.waiting_for_human_runs}`} tone="danger" />
                  <StatusPill label={`Replan ${item.reconciliation_runs}`} tone="brand" />
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  Engines: {Object.entries(item.engines)
                    .map(([engine, count]) => `${engine.replace("_", " ")} ${count}`)
                    .join(" · ")}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Last seen: {item.last_seen_at ? new Date(item.last_seen_at).toLocaleString() : "No recent runs"}
                </Typography>
              </Stack>
            </SurfaceCard>
          ))}
        </Stack>
      ) : (
        <EmptyStateCard
          title="No incident analytics yet"
          description="Once runs hit runtime blockers like auth walls, overlays, or navigation drift, the site and incident breakdown will appear here."
        />
      )}

      <SectionHeader
        eyebrow="Schedules"
        title="Upcoming events from chat"
        description="When chat resolves a task into a once, interval, or multi-time automation, it appears here as an upcoming event card."
      />

      {schedules.length === 0 ? (
        <EmptyStateCard
          title="No scheduled automations yet"
          description="Ask for a recurring or later run in chat and the upcoming event will appear here automatically."
        />
      ) : (
        <Stack spacing={2}>
          {schedules.map((schedule) => (
            <SurfaceCard
              key={schedule.schedule_id}
              eyebrow="Upcoming event"
              title={schedule.summary}
              subtitle={schedule.user_goal}
            >
              <Stack spacing={2}>
                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                  <StatusPill
                    label={schedule.status === "draft" ? "pending setup" : "scheduled"}
                    tone={schedule.status === "draft" ? "warning" : "success"}
                  />
                  <StatusPill label={schedule.execution_mode.replace("_", " ")} tone="brand" />
                  {schedule.executor_mode ? (
                    <StatusPill label={schedule.executor_mode.replace("_", " ")} tone="neutral" />
                  ) : null}
                  {schedule.automation_engine ? (
                    <StatusPill label={schedule.automation_engine.replace("_", " ")} tone="brand" />
                  ) : null}
                  <StatusPill label={schedule.timezone} tone="neutral" />
                </Stack>

                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" },
                    gap: 2,
                  }}
                >
                  <Box
                    sx={{
                      p: 2.5,
                      borderRadius: "18px",
                      backgroundColor: "var(--surface-card-muted)",
                      border: "1px solid var(--border-subtle)",
                    }}
                  >
                    <Typography variant="overline" color="text.secondary">
                      Created
                    </Typography>
                    <Typography variant="body2">{new Date(schedule.created_at).toLocaleString()}</Typography>
                  </Box>
                  <Box
                    sx={{
                      p: 2.5,
                      borderRadius: "18px",
                      backgroundColor: "var(--surface-card-muted)",
                      border: "1px solid var(--border-subtle)",
                    }}
                  >
                    <Typography variant="overline" color="text.secondary">
                      Next occurrences
                    </Typography>
                    {schedule.run_times.length > 0 ? (
                      <Stack spacing={0.75} mt={1}>
                        {schedule.run_times.map((time) => (
                          <Typography key={time} variant="body2">
                            {new Date(time).toLocaleString()}
                          </Typography>
                        ))}
                      </Stack>
                    ) : (
                      <Typography variant="body2" color="text.secondary" mt={1}>
                        Waiting for the exact upcoming time from chat.
                      </Typography>
                    )}
                  </Box>
                </Box>
              </Stack>
            </SurfaceCard>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
