from oi_agent.config import settings


def test_config_redacted_summary_masks_secrets() -> None:
    summary = settings.redacted_summary()

    assert "runtime" in summary
    assert summary["runtime"]["shared_secret"] != settings.automation_runtime_shared_secret
    assert summary["runner"]["shared_secret"] != settings.runner_shared_secret


def test_config_validate_startup_requires_runtime_secret_when_enabled() -> None:
    original_enabled = settings.automation_runtime_enabled
    original_secret = settings.automation_runtime_shared_secret
    try:
        settings.automation_runtime_enabled = True
        settings.automation_runtime_shared_secret = ""
        missing = settings.validate_startup()
        assert "AUTOMATION_RUNTIME_SHARED_SECRET" in missing
    finally:
        settings.automation_runtime_enabled = original_enabled
        settings.automation_runtime_shared_secret = original_secret
