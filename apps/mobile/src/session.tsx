import { CuaClient, newIdentity, parseIdentity, serializeIdentity, type ClientEvent, type TerminalHandle } from "@cuaremote/client";
import { defaultHubURL, secureGet, secureSet } from "./platform";
import Purchases from "react-native-purchases";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { initialState, reduce, type AppState, type Approval } from "./store";

const ID_KEY = "cuaremote.identity",
  URL_KEY = "cuaremote.hubURL";
interface Session {
  state: AppState;
  connection: "connecting" | "online" | "offline";
  accountId?: string;
  hubURL: string;
  pro: boolean;
  ready: boolean;
  submit(text: string, variants?: number, label?: string): Promise<void>;
  request(body: any, type: any): Promise<any>;
  approve(a: Approval, allow: boolean): Promise<void>;
  upload(name: string, blob: Blob): Promise<string>;
  openTerminal(c: number, r: number): Promise<TerminalHandle>;
  setHubURL(v: string): Promise<void>;
  refresh(): void;
  refreshPurchases(): Promise<void>;
}
const Context = createContext<Session | null>(null);
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [connection, setConnection] = useState<Session["connection"]>("offline");
  const [accountId, setAccountId] = useState<string>();
  const [hubURL, setURL] = useState(defaultHubURL());
  const [pro, setPro] = useState(false);
  const [ready, setReady] = useState(false);
  const client = useRef<CuaClient | undefined>(undefined);
  const refreshPurchases = useCallback(async () => {
    try {
      const i = await Purchases.getCustomerInfo();
      setPro(Boolean(i.entitlements.active.pro));
    } catch {}
  }, []);
  const refresh = useCallback(() => {
    client.current?.request({ type: "cloud.status.get" }, "cloud.status").catch(() => {});
    client.current?.sendHub({ type: "billing.get" });
  }, []);
  useEffect(() => {
    let alive = true;
    let off: undefined | (() => void);
    (async () => {
      let raw = await secureGet(ID_KEY);
      if (!raw) {
        raw = serializeIdentity(await newIdentity());
        await secureSet(ID_KEY, raw);
      }
      const saved = await secureGet(URL_KEY);
      const url = saved || hubURL;
      if (saved) setURL(saved);
      if (!alive) return;
      const c = new CuaClient({ url, identity: parseIdentity(raw), name: "我的 iPhone", platform: "ios" });
      client.current = c;
      off = c.subscribe((e: ClientEvent) => {
        if (e.kind === "message") dispatch(e.message);
        else {
          setConnection(e.state);
          if (e.accountId) {
            setAccountId(e.accountId);
            Purchases.logIn(e.accountId)
              .then(refreshPurchases)
              .catch(() => {});
            setTimeout(refresh, 100);
          }
        }
      });
      c.start();
      setReady(true);
    })();
    return () => {
      alive = false;
      off?.();
      client.current?.stop();
    };
  }, [hubURL]);
  useEffect(() => {
    const key = process.env.EXPO_PUBLIC_REVENUECAT_API_KEY;
    if (key) {
      try {
        Purchases.configure({ apiKey: key });
        void refreshPurchases();
      } catch {}
    }
  }, []);
  const value = useMemo<Session>(
    () => ({
      state,
      connection,
      accountId,
      hubURL,
      pro,
      ready,
      submit: async (t, v, label) => {
        if (label) dispatch({ type: "local.label", intent: t, label });
        await client.current!.submit(t, { variants: v, title: label });
      },
      request: (b, t) => client.current!.request(b, t),
      approve: async (a, x) => {
        await client.current!.approve(a, x);
      },
      upload: (n, b) => client.current!.upload(n, b),
      openTerminal: (c, r) => client.current!.openTerminal(c, r),
      setHubURL: async (v) => {
        await secureSet(URL_KEY, v);
        setURL(v);
      },
      refresh,
      refreshPurchases,
    }),
    [state, connection, accountId, hubURL, pro, ready, refresh, refreshPurchases],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useSession = () => {
  const x = useContext(Context);
  if (!x) throw new Error("SessionProvider missing");
  return x;
};
