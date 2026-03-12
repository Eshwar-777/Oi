from oi_agent.automation.models import IntentDraft
from oi_agent.automation.response_composer import (
    compose_intent_response,
    compose_resolution_message,
)


def _intent(*, decision: str, timing_mode: str = "unknown") -> IntentDraft:
    return IntentDraft(
        intent_id="intent-1",
        session_id="session-1",
        user_goal="schedule the release review",
        goal_type="ui_automation",
        normalized_inputs=[],
        decision=decision,  # type: ignore[arg-type]
        timing_mode=timing_mode,  # type: ignore[arg-type]
    )


def test_ready_to_schedule_opens_schedule_builder_with_detected_mode() -> None:
    message, actions = compose_intent_response(_intent(decision="READY_TO_SCHEDULE", timing_mode="once"))

    assert message.text == "I understand the task and can schedule it."
    assert len(actions) == 1
    assert actions[0].type == "open_schedule_builder"
    assert actions[0].payload["mode"] == "once"


def test_ready_for_multi_time_schedule_uses_multi_time_builder_mode() -> None:
    message, actions = compose_intent_response(
        _intent(decision="READY_FOR_MULTI_TIME_SCHEDULE", timing_mode="multi_time")
    )

    assert message.text == "I understand the task and can schedule it at multiple times."
    assert len(actions) == 1
    assert actions[0].type == "open_schedule_builder"
    assert actions[0].payload["mode"] == "multi_time"


def test_scheduled_resolution_message_points_user_to_schedules_tab() -> None:
    message = compose_resolution_message("scheduled")

    assert message.text == "The schedule is created. Check the schedules tab for the scheduled task."
