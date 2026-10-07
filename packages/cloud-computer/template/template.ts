import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Template } from "e2b";
import { WORK_DIR } from "../src/constants.js";

const osc133 = readFileSync(fileURLToPath(new URL("../../brain/shell-integration/cuaremote.bash", import.meta.url)), "utf8");

/**
 * 在 E2B 自带的 base 模板（Debian 12 + python3 + node + git）上补齐：
 * 文档转换（pandoc / LibreOffice 无界面版 / poppler）、音视频（ffmpeg）、图片（ImageMagick）、
 * 无头 Chromium（截图对比分叉结果）、中日韩字体、bun、faster-whisper（录音转文字），以及终端命令块用的 OSC 133 集成。
 */
export const template = Template()
  .fromTemplate("base")
  .aptInstall(
    [
      "ffmpeg",
      "pandoc",
      "imagemagick",
      "poppler-utils",
      "libreoffice-writer-nogui",
      "libreoffice-calc-nogui",
      "libreoffice-impress-nogui",
      "chromium",
      "fonts-noto-cjk",
      "fonts-noto-color-emoji",
      "jq",
      "ripgrep",
      "unzip",
      "zip",
      "iproute2",
    ],
    { noInstallRecommends: true },
  )
  .pipInstall(["faster-whisper", "python-docx", "pdf2docx", "yt-dlp"])
  .runCmd("curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash && bun --version", { user: "root" })
  .runCmd(`mkdir -p ${WORK_DIR} /home/user/.cuaremote && chown -R user:user ${WORK_DIR} /home/user/.cuaremote`, { user: "root" })
  .runCmd(`cat > /home/user/.cuaremote/osc133.bash <<'CUAREMOTE_EOF'\n${osc133}\nCUAREMOTE_EOF`)
  .runCmd(`grep -q osc133.bash /home/user/.bashrc || echo '[ -n "$PS1" ] && . /home/user/.cuaremote/osc133.bash; cd ${WORK_DIR} 2>/dev/null' >> /home/user/.bashrc`)
  .setWorkdir(WORK_DIR);
