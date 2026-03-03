def route_interaction(message: str) -> str:
    msg = message.lower()
    if any(token in msg for token in ["camera", "image", "vision"]):
        return "vision_analysis"
    if any(token in msg for token in ["screen", "click", "computer"]):
        return "computer_use"
    if any(token in msg for token in ["voice", "live", "stream"]):
        return "live_multimodal"
    return "text_chat"
