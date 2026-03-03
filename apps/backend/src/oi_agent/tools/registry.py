from collections.abc import Callable


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Callable] = {}

    def register(self, name: str, fn: Callable) -> None:
        self._tools[name] = fn

    def get(self, name: str) -> Callable:
        return self._tools[name]
