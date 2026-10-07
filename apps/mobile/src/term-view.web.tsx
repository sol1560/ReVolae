import React, { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { TERM_HTML, type TermViewHandle, type TermViewProps } from "./term-html";

/** 网页预览：iframe 里跑同一份 xterm.js，用 postMessage 通信 */
export const TermView = forwardRef<TermViewHandle, TermViewProps>(function TermView({ onMessage }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  useImperativeHandle(ref, () => ({ write: (s) => (frame.current?.contentWindow as unknown as { write?: (d: string) => void } | null)?.write?.(s) }));
  useEffect(() => {
    const fn = (e: MessageEvent) => {
      if (e.source === frame.current?.contentWindow && typeof e.data === "string") onMessage(e.data);
    };
    window.addEventListener("message", fn);
    return () => window.removeEventListener("message", fn);
  }, [onMessage]);
  return <iframe ref={frame} srcDoc={TERM_HTML("parent.postMessage")} style={{ flex: 1, border: 0, width: "100%", height: "100%", background: "#090b10" }} />;
});
