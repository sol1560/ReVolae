// 网页预览版（浏览器里看界面和真实云电脑联动用）：localStorage 存身份、没有面容 ID、直接用浏览器下载。
export const secureGet = async (k: string) => localStorage.getItem(k);
export const secureSet = async (k: string, v: string) => localStorage.setItem(k, v);

/** 网页没有面容 ID；签名仍然照做，只是跳过生物识别这一步 */
export async function authenticate(_prompt: string): Promise<boolean> {
  return true;
}

export async function saveAndShare(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.target = "_blank";
  a.click();
}

/** 预览服务器把 /ws 转给 hub，所以默认连同源 */
export const defaultHubURL = () => process.env.EXPO_PUBLIC_HUB_URL ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
export const isWebPreview = true;

export async function confirm(title: string, detail: string, _ok: string): Promise<boolean> {
  return window.confirm(`${title}\n\n${detail}`);
}

export function notify(title: string, detail?: string) {
  window.alert(detail ? `${title}\n\n${detail}` : title);
}

/** 浏览器文件选择：只等 change（有的浏览器会提前发 cancel，忽略它；真取消时按钮保持原样即可） */
export function pickDocument(): Promise<{ name: string; blob: Blob } | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const f = input.files?.[0];
      input.remove();
      resolve(f ? { name: f.name, blob: f } : undefined);
    });
    input.click();
  });
}
