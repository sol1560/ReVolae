export interface TermViewHandle {
  write(s: string): void;
}
export interface TermViewProps {
  onMessage(raw: string): void;
}

/** xterm.js 页面；post 是把消息发回 App 的函数名（WebView / iframe 不同） */
export const TERM_HTML = (post: string) =>
  `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm/css/xterm.css"><style>html,body,#t{height:100%;margin:0;background:#090b10}</style><div id="t"></div><script src="https://cdn.jsdelivr.net/npm/@xterm/xterm/lib/xterm.js"></script><script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit/lib/addon-fit.js"></script><script>const post=(m)=>${post}(JSON.stringify(m),'*');const t=new Terminal({cursorBlink:true,fontSize:13,theme:{background:'#090b10',foreground:'#f5f7fa'}});const fit=new FitAddon.FitAddon();t.loadAddon(fit);t.open(document.querySelector('#t'));fit.fit();t.onData(d=>post({type:'data',data:d}));window.write=d=>t.write(d);window.addEventListener('resize',()=>{fit.fit();post({type:'resize',cols:t.cols,rows:t.rows})});post({type:'ready',cols:t.cols,rows:t.rows});</script>`;
