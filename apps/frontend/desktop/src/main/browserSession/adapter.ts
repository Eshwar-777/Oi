export interface BrowserPageTarget {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl?: string;
  active?: boolean;
}

export interface BrowserSessionInputPayload {
  input_type?: "click" | "type" | "scroll" | "keypress" | "move" | "mouse_down" | "mouse_up";
  x?: number;
  y?: number;
  text?: string;
  delta_x?: number;
  delta_y?: number;
  key?: string;
  button?: "left" | "middle" | "right";
}

export interface BrowserSessionFrame {
  screenshot: string;
  current_url: string;
  page_title: string;
  page_id: string;
  viewport?: {
    width: number;
    height: number;
    dpr: number;
  };
}

export interface BrowserSessionAdapter {
  readonly kind: string;
  readonly runtime?: string;
  readonly version?: string;
  listPages(cdpUrl: string): Promise<BrowserPageTarget[]>;
  captureFrame(cdpUrl: string): Promise<BrowserSessionFrame | null>;
  navigate(cdpUrl: string, url: string): Promise<void>;
  dispatchInput(cdpUrl: string, payload: BrowserSessionInputPayload): Promise<void>;
}
