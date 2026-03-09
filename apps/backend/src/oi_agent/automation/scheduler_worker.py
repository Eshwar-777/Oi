from __future__ import annotations

import asyncio
import logging

from oi_agent.api.browser.schedule_runner import run_scheduler_forever
from oi_agent.config import settings
from oi_agent.observability.telemetry import configure_logging

configure_logging(settings.log_level, settings.log_format, settings.log_scope)
logger = logging.getLogger(__name__)


async def _main() -> None:
    logger.info("OI automation scheduler worker started")
    await run_scheduler_forever()


def main() -> None:
    asyncio.run(_main())


if __name__ == "__main__":
    main()
