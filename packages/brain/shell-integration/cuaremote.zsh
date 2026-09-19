# CuaRemote 终端命令分块（zsh）
# 用法：在 ~/.zshrc 末尾加一行
#   [[ -n "$CUAREMOTE_SESSION" ]] && source /path/to/cuaremote.zsh
# daemon 打开终端会话时会设置 CUAREMOTE_SESSION，普通终端里不生效。
# 发出的标记：OSC 133;A（提示符开始）、B（用户开始输入）、C;cmd=<百分号编码的命令>（开始执行）、D;<退出码>（执行结束）、OSC 7（当前目录）。

[[ -n "$CUAREMOTE_SHELL_INTEGRATED" ]] && return
CUAREMOTE_SHELL_INTEGRATED=1

__cuaremote_urlencode() {
  local s="$1" out="" c i
  for (( i = 1; i <= ${#s}; i++ )); do
    c="${s[i]}"
    case "$c" in
      [a-zA-Z0-9._~-]) out+="$c" ;;
      *) out+=$(printf '%%%02X' "'$c") ;;
    esac
  done
  print -rn -- "$out"
}

__cuaremote_osc7() {
  printf '\e]7;file://%s%s\a' "${HOST}" "$(__cuaremote_urlencode "$PWD" | sed 's/%2F/\//g')"
}

__cuaremote_precmd() {
  local code=$?
  if [[ -n "$__cuaremote_running" ]]; then
    printf '\e]133;D;%d\a' "$code"
    unset __cuaremote_running
  fi
  __cuaremote_osc7
  printf '\e]133;A\a'
}

__cuaremote_preexec() {
  __cuaremote_running=1
  printf '\e]133;C;cmd=%s\a' "$(__cuaremote_urlencode "$1")"
}

# 提示符前后各放一个标记：B 表示提示符画完、用户开始输入
autoload -Uz add-zsh-hook
add-zsh-hook precmd __cuaremote_precmd
add-zsh-hook preexec __cuaremote_preexec
PS1="${PS1}%{$(printf '\e]133;B\a')%}"
