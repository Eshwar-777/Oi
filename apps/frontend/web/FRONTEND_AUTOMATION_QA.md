# Frontend Automation QA

## Core expectations

- General chat should render only assistant conversation, not automation cards.
- Clarification turns should show only the clarification card and reply path.
- Execution-mode turns should show only the allowed mode choices from backend.
- Confirmation turns should show a confirmation card and button.
- Active runs should reflect backend state through `/api/events/stream`.
- `waiting_for_user_action` should show `Resume` and `Stop`, plus explicit guidance to complete the manual step first.
- `queued`, `running`, `paused`, `failed`, `completed`, and `cancelled` should render distinct run updates and controls.
- Missing-field chips should be human-readable, not snake_case.

## Manual scenarios

1. General chat
   - Input: `hi`
   - Expect: one assistant reply, no clarification card, no execution-mode card, no run controls.

2. Clarification flow
   - Input: `send a message to dippa on whatsapp`
   - Expect: clarification asking for message text, chip `Message text`.

3. Follow-up clarification merge
   - After scenario 2, input: `hi ra`
   - Expect: execution-mode question, not another app question.

4. Timing update follow-up
   - After scenario 3, input: `tomorrow at 4pm`
   - Expect: confirmation prompt for scheduled send.

5. Immediate run
   - Input: `open notion now`
   - Expect: run card progresses through queued/running/completed via event stream.

6. Waiting state
   - Trigger a backend run that enters `waiting_for_user_action`
   - Expect: run card with `Resume` and `Stop`, plus manual-step guidance.

7. Pause/resume
   - Pause a running run
   - Expect: paused state, resume/stop controls.

8. Failure
   - Trigger `run.failed`
   - Expect: retry button and friendly error copy.

9. Scheduled run
   - Choose `once` or `interval`
   - Expect: schedule UI and scheduled run status without immediate-run controls.

## Verification performed in this worktree

- `pnpm --filter @oi/web typecheck`
- `pnpm --filter @oi/web build`
