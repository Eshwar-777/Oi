import {
    List,
    ListItem,
    Box,
    Stack,
    SvgIcon,
    Typography,
  } from "@mui/material";
import { StepPresentationStatus } from "./ChatTypes";
import { StatusPill } from "@oi/design-system-web";

export function toneForRunState(
    state: string,
  ): "neutral" | "brand" | "warning" | "success" | "danger" | "info" {
    if (state === "completed") return "success";
    if (state === "failed" || state === "cancelled") return "danger";
    if (state === "paused" || state === "waiting_for_user_action") return "warning";
    if (state === "scheduled") return "info";
    if (state === "running" || state === "queued" || state === "retrying") return "brand";
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
  
  export function stepStatusPath(status: StepPresentationStatus) {
    switch (status) {
      case "completed":
        return "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15l-5-5 1.41-1.41L11 14.17l7.59-7.59L20 8l-9 9z";
      case "running":
        return "M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0020 12c0-4.42-3.58-8-8-8zm-6.76.74L3.78 6.2A7.93 7.93 0 004 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8z";
      case "failed":
        return "M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z";
      case "paused":
        return "M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z";
      case "waiting":
        return "M12 2C6.48 2 2 6.48 2 12h2a8 8 0 111.76 5.03l1.42 1.42A10 10 0 1012 2zm-1 5h2v6h-2zm0 8h2v2h-2z";
      default:
        return "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z";
    }
  }
  
  export function StepStatusIcon({ status }: { status: StepPresentationStatus }) {
    return (
      <SvgIcon sx={{ fontSize: 22, color: stepStatusColor(status), flexShrink: 0, mt: 0.25 }}>
        <path d={stepStatusPath(status)} />
      </SvgIcon>
    );
  }
  
  export function CalendarIcon() {
    return (
      <SvgIcon sx={{ fontSize: 22 }}>
        <path d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 15H5V10h14zm0-11H5V6h14z" />
      </SvgIcon>
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
    return state === "waiting_for_user_action" ? "Continue" : "Resume";
  }