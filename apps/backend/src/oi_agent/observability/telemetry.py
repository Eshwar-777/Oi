import logging

import structlog


def configure_logging(level: str) -> None:
    logging.basicConfig(level=level)
    structlog.configure(
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelName(level)),
    )
