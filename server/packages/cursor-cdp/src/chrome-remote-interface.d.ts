declare module "chrome-remote-interface" {
  export interface Target {
    targetId: string;
    type: string;
    title: string;
    url: string;
    attached: boolean;
  }

  export interface Client {
    on(event: "disconnect", listener: () => void): this;
    close(): Promise<void>;
    Runtime: {
      enable(): Promise<void>;
      evaluate(params: {
        expression: string;
        returnByValue?: boolean;
      }): Promise<{ result: { value?: unknown } }>;
    };
    Target: {
      enable(): Promise<void>;
      getTargets(): Promise<{ targetInfos: Target[] }>;
      activateTarget(params: { targetId: string }): Promise<void>;
    };
    Page: {
      enable(): Promise<void>;
      captureScreenshot(params: {
        format?: "png" | "jpeg" | "webp";
        quality?: number;
        captureBeyondViewport?: boolean;
        fromSurface?: boolean;
      }): Promise<{ data: string }>;
    };
    Input: {
      enable(): Promise<void>;
      insertText(params: { text: string }): Promise<void>;
      dispatchKeyEvent(params: {
        type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
        key?: string;
        code?: string;
        text?: string;
        modifiers?: number;
        windowsVirtualKeyCode?: number;
        nativeVirtualKeyCode?: number;
      }): Promise<void>;
    };
  }

  function CDP(options?: { port?: number; host?: string }): Promise<Client>;

  export = CDP;
}
