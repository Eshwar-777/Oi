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
import { useAssistant } from "@/features/assistant/AssistantContext";

export function SchedulesPage() {
  const { schedules } = useAssistant();

  return (
    <Stack spacing={3}>
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
