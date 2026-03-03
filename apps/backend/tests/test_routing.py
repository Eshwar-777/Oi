from oi_agent.agents.langgraph_flow import route_interaction


def test_routing_defaults_to_text_chat() -> None:
    assert route_interaction("hello") == "text_chat"


def test_routing_vision() -> None:
    assert route_interaction("analyze this image") == "vision_analysis"
