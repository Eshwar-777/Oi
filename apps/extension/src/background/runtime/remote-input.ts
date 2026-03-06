export async function handleRemoteInputCommand(
  payload: Record<string, unknown>,
  deps: {
    getFirstAttachedTabId: () => number | null;
    enqueueTabCommand: <T>(tabId: number, task: () => Promise<T>) => Promise<T>;
    ensureDebugger: (tabId: number) => Promise<void>;
    cdp: (tabId: number, method: string, params?: Record<string, unknown>) => Promise<unknown>;
    onError?: (error: unknown) => void;
  },
): Promise<void> {
  const inputType = payload.input_type as string;
  const tabId = (payload.tab_id as number) || deps.getFirstAttachedTabId();
  if (!tabId) return;

  try {
    await deps.enqueueTabCommand(tabId, async () => {
      await deps.ensureDebugger(tabId);
      if (inputType === "click") {
        const x = payload.x as number;
        const y = payload.y as number;
        await deps.cdp(tabId, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        await deps.cdp(tabId, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
      } else if (inputType === "type") {
        await deps.cdp(tabId, "Input.insertText", { text: payload.key as string });
      } else if (inputType === "scroll") {
        await deps.cdp(tabId, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: 400,
          y: 400,
          deltaX: (payload.dx as number) ?? 0,
          deltaY: (payload.dy as number) ?? 100,
        });
      }
    });
  } catch (error) {
    deps.onError?.(error);
  }
}
