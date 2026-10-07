import React, { forwardRef, useImperativeHandle, useRef } from "react";
import { WebView } from "react-native-webview";
import { C } from "./theme";
import { TERM_HTML, type TermViewHandle, type TermViewProps } from "./term-html";

/** iPhone：WebView 里跑 xterm.js */
export const TermView = forwardRef<TermViewHandle, TermViewProps>(function TermView({ onMessage }, ref) {
  const web = useRef<WebView>(null);
  useImperativeHandle(ref, () => ({ write: (s) => web.current?.injectJavaScript(`window.write(${JSON.stringify(s)});true;`) }));
  return <WebView ref={web} originWhitelist={["*"]} source={{ html: TERM_HTML("ReactNativeWebView.postMessage") }} onMessage={(e) => onMessage(e.nativeEvent.data)} style={{ flex: 1, backgroundColor: C.bg }} />;
});
