import {
    List,
    ListItem,
    Box,
    Stack,
    Typography,
  } from "@mui/material";
import { StepPresentationStatus } from "./ChatTypes";
import { MaterialSymbol, StatusPill } from "@oi/design-system-web";

export function toneForRunState(
    state: string,
  ): "neutral" | "brand" | "warning" | "success" | "danger" | "info" {
    if (state === "completed" || state === "succeeded") return "success";
    if (state === "failed" || state === "cancelled" || state === "canceled" || state === "timed_out") return "danger";
    if (state === "paused" || state === "waiting_for_user_action" || state === "waiting_for_human" || state === "human_controlling") return "warning";
    if (state === "scheduled") return "info";
    if (state === "running" || state === "queued" || state === "retrying" || state === "starting" || state === "resuming") return "brand";
    return "neutral";
  }
  
  export function stepStatusLabel(status: StepPresentationStatus) {
    switch (status) {
      case "completed":
        return "Completed";
      case "running":
        return "In progress";
      case "failed":
        return "Failed";
      case "paused":
        return "Paused";
      case "waiting":
        return "Waiting for you";
      default:
        return "Pending";
    }
  }
  
  export function stepStatusTone(
    status: StepPresentationStatus,
  ): "neutral" | "brand" | "warning" | "success" | "danger" | "info" {
    switch (status) {
      case "completed":
        return "success";
      case "running":
        return "brand";
      case "failed":
        return "danger";
      case "paused":
      case "waiting":
        return "warning";
      default:
        return "neutral";
    }
  }
  
  export function stepStatusColor(status: StepPresentationStatus) {
    switch (status) {
      case "completed":
        return "#2e7d32";
      case "running":
        return "#0b57d0";
      case "failed":
        return "#b3261e";
      case "paused":
      case "waiting":
        return "#b26a00";
      default:
        return "var(--text-secondary)";
    }
  }
  
export function StepStatusIcon({ status }: { status: StepPresentationStatus }) {
  return (
      <MaterialSymbol
        name={
          status === "completed"
            ? "check_circle"
            : status === "running"
              ? "refresh"
              : status === "failed"
                ? "error"
                : status === "paused"
                  ? "pause"
                  : status === "waiting"
                    ? "warning"
                    : "pending"
        }
        sx={{ fontSize: 20, color: stepStatusColor(status), flexShrink: 0, mt: 0.25 }}
      />
  );
}
  
export function CalendarIcon() {
  return (
      <MaterialSymbol name="schedule" sx={{ fontSize: 20 }} />
  );
}
  
  export function renderStepRows(
    steps: Array<{
      step_id: string;
      label: string;
      description?: string;
      meta?: string;
      status: StepPresentationStatus;
    }>,
  ) {
    return (
      <List disablePadding>
        {steps.map((step) => (
          <ListItem key={step.step_id} disableGutters alignItems="flex-start" sx={{ gap: 1.5, py: 1.1 }}>
            <StepStatusIcon status={step.status} />
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Stack
                direction={{ xs: "column", sm: "row" }}
                spacing={1}
                alignItems={{ xs: "flex-start", sm: "center" }}
                justifyContent="space-between"
                sx={{ mb: 0.25 }}
              >
                <Typography variant="body2" fontWeight={700}>
                  {step.label}
                </Typography>
                <StatusPill label={stepStatusLabel(step.status)} tone={stepStatusTone(step.status)} />
              </Stack>
              <Typography variant="body2" color="text.secondary">
                {step.meta || step.description || "Waiting for this step to begin."}
              </Typography>
            </Box>
          </ListItem>
        ))}
      </List>
    );
  }
  
  export function getRunActionLabel(state: string) {
    return state === "waiting_for_user_action" || state === "waiting_for_human" ? "Continue" : "Resume";
  }
