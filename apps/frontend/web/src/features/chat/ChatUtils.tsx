import {
    List,
    ListItem,
    Box,
    Stack,
    Typography,
  } from "@mui/material";
import type {
  AgentBrowserStepPayload,
  AgentBrowserTargetPayload,
} from "../../domain/automation";
import { StepPresentationStatus } from "./ChatTypes";
import { MaterialSymbol, StatusPill } from "@oi/design-system-web";
  
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

function summarizeTargetCandidate(candidate: Record<string, unknown>): string | null {
  if (typeof candidate.ref === "string") {
    return candidate.ref;
  }
  if (typeof candidate.role === "string" && typeof candidate.name === "string") {
    return `${candidate.role}:"${candidate.name}"`;
  }
  if (typeof candidate.role === "string") {
    return `role:${candidate.role}`;
  }
  if (typeof candidate.label === "string") {
    return `label:"${candidate.label}"`;
  }
  if (typeof candidate.placeholder === "string") {
    return `placeholder:"${candidate.placeholder}"`;
  }
  if (typeof candidate.text === "string") {
    return `text:"${candidate.text}"`;
  }
  if (typeof candidate.testid === "string") {
    return `testid:${candidate.testid}`;
  }
  if (typeof candidate.testId === "string") {
    return `testid:${candidate.testId}`;
  }
  return null;
}

function summarizeTarget(
  target?: string | AgentBrowserTargetPayload | null,
): string | null {
  if (!target) {
    return null;
  }
  if (typeof target === "string") {
    return target;
  }

  const candidates = Array.isArray(target.candidates) ? target.candidates : [];
  const rendered = candidates
    .map((candidate) =>
      candidate && typeof candidate === "object"
        ? summarizeTargetCandidate(candidate as Record<string, unknown>)
        : null,
    )
    .filter((candidate): candidate is string => Boolean(candidate));

  return rendered.length > 0 ? rendered.slice(0, 2).join(" | ") : null;
}

function formatCommandPayload(payload?: AgentBrowserStepPayload): string | null {
  if (!payload?.command) {
    return null;
  }

  const parts: string[] = [payload.command];

  const target = summarizeTarget(payload.target);
  if (target) {
    parts.push(target);
  }

  if (typeof payload.value === "string" && payload.value.trim()) {
    parts.push(`"${payload.value}"`);
  }

  if (Array.isArray(payload.args) && payload.args.length > 0) {
    parts.push(payload.args.join(" "));
  }

  if (typeof payload.snapshot_id === "string" && payload.snapshot_id.trim()) {
    parts.push(`snapshot:${payload.snapshot_id}`);
  }

  return parts.join(" · ");
}
  
  export function renderStepRows(
    steps: Array<{
      step_id: string;
      label: string;
      command_payload?: AgentBrowserStepPayload;
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
                {(() => {
                  const payloadText =
                    step.command_payload && Object.keys(step.command_payload).length
                      ? formatCommandPayload(step.command_payload)
                      : null;

                  if (payloadText && step.meta) {
                    return `${payloadText} · ${step.meta}`;
                  }

                  return (
                    payloadText
                    || step.meta
                    || step.description
                    || "Waiting for this step to begin."
                  );
                })()}
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
