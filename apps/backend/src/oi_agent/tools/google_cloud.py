from oi_agent.config import settings


def get_project_context() -> dict[str, str]:
    return {
        "project": settings.gcp_project,
        "location": settings.gcp_location,
    }
