import type { QuickCard } from "@cuaremote/protocol";

/**
 * 快捷命令卡：手机首页上点一下就能用的常用任务。
 * 手机填好字段后，把 intent 里的 {key} 换成填的值，作为普通意图发给云电脑。
 * 文件字段由手机先上传到 /home/user/work/inbox/，再把沙箱里的路径填进去。
 */
export const QUICK_CARDS: QuickCard[] = [
  {
    id: "pdf-to-word",
    title: "PDF 转 Word",
    icon: "doc.richtext",
    subtitle: "保留排版，做好直接下载",
    fields: [{ key: "file", label: "PDF 文件", kind: "file", accept: ["application/pdf"] }],
    intent: "把 {file} 转成 Word（.docx），尽量保留排版和图片，做好后给我下载。",
  },
  {
    id: "video-trim",
    title: "剪视频",
    icon: "scissors",
    subtitle: "截一段、压缩、转格式",
    fields: [
      { key: "file", label: "视频", kind: "file", accept: ["video/"] },
      { key: "range", label: "要保留的时间段", kind: "text", placeholder: "例如 00:12 到 01:05" },
      { key: "target", label: "输出", kind: "choice", choices: ["原画质", "压到 20MB 以内", "转成 GIF"] },
    ],
    intent: "把视频 {file} 剪出 {range}，输出要求：{target}。做好后给我下载。",
  },
  {
    id: "transcribe",
    title: "录音转文字",
    icon: "waveform",
    subtitle: "转写并整理成要点",
    fields: [
      { key: "file", label: "录音", kind: "file", accept: ["audio/", "video/"] },
      { key: "style", label: "整理成", kind: "choice", choices: ["逐字稿", "会议纪要", "要点摘要"] },
    ],
    intent: "用 faster-whisper 把 {file} 转成文字，再整理成{style}，存成 Markdown 文件给我下载。",
  },
  {
    id: "landing-page",
    title: "做个网页",
    icon: "globe",
    subtitle: "描述一下，马上给你预览链接",
    fields: [{ key: "brief", label: "网页要做什么", kind: "text", placeholder: "例如：我的咖啡店落地页，暖色调，有菜单和地址" }],
    intent: "在 /home/user/work/site 做一个单页网站：{brief}。用纯 HTML/CSS（可以用 CDN 上的库），在 8080 端口起服务并给我预览链接。",
    variants: true,
  },
  {
    id: "repo-test",
    title: "拉仓库跑测试",
    icon: "hammer",
    subtitle: "克隆、装依赖、跑测试、告诉你结果",
    fields: [{ key: "repo", label: "仓库地址", kind: "text", placeholder: "https://github.com/owner/repo" }],
    intent: "克隆 {repo} 到 /home/user/work/，按它的 README 装好依赖并跑测试，告诉我结果；失败的话说明原因。",
  },
];

/** 把字段值填进卡片的意图模板；缺字段时报错，不发半截意图 */
export function fillCard(card: QuickCard, values: Record<string, string>): string {
  return card.intent.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = values[k]?.trim();
    if (!v) throw new Error(`「${card.fields.find((f) => f.key === k)?.label ?? k}」还没填`);
    return v;
  });
}
