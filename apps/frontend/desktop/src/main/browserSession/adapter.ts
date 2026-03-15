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

export interface BrowserSessionTargetSelector {
  pageId?: string;
  url?: string;
  title?: string;
  tabIndex?: number;
}

export interface BrowserSessionAdapter {
  readonly kind: string;
  readonly runtime?: string;
  readonly version?: string;
  getCaptureMode?(): "browser_window" | "page_surface";
  listPages(cdpUrl: string): Promise<BrowserPageTarget[]>;
  captureFrame(cdpUrl: string, target?: BrowserSessionTargetSelector): Promise<BrowserSessionFrame | null>;
  activatePage(cdpUrl: string, target: BrowserSessionTargetSelector): Promise<void>;
  navigate(cdpUrl: string, url: string): Promise<void>;
  openTab(cdpUrl: string, url?: string): Promise<void>;
  dispatchInput(cdpUrl: string, payload: BrowserSessionInputPayload, target?: BrowserSessionTargetSelector): Promise<void>;
}
