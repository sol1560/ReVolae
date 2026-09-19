# CuaRemote 终端命令分块（bash ≥ 4）
# 用法：在 ~/.bashrc 末尾加一行
#   [[ -n "$CUAREMOTE_SESSION" ]] && source /path/to/cuaremote.bash
# 标记含义见 cuaremote.zsh。bash 没有 preexec，用 DEBUG trap 模拟。

[[ -n "$CUAREMOTE_SHELL_INTEGRATED" ]] && return
CUAREMOTE_SHELL_INTEGRATED=1

__cuaremote_urlencode() {
  local s="$1" out="" c i
  for (( i = 0; i < ${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9._~-]) out+="$c" ;;
      *) out+=$(printf '%%%02X' "'$c") ;;
    esac
  done
  printf '%s' "$out"
}

__cuaremote_precmd() {
  local code=$?
  if [[ -n "$__cuaremote_running" ]]; then
    printf '\e]133;D;%d\a' "$code"
    unset __cuaremote_running
  fi
  printf '\e]7;file://%s%s\a' "${HOSTNAME}" "$(__cuaremote_urlencode "$PWD" | sed 's/%2F/\//g')"
  printf '\e]133;A\a'
  __cuaremote_in_prompt=1
}

__cuaremote_preexec() {
  # DEBUG trap 在每条简单命令前都会触发；只在提示符刚结束的第一次发 C
  [[ -n "$COMP_LINE" || -z "$__cuaremote_in_prompt" ]] && return
  unset __cuaremote_in_prompt
  __cuaremote_running=1
  local cmd
  cmd=$(HISTTIMEFORMAT= history 1 | sed 's/^ *[0-9]* *//')
  printf '\e]133;C;cmd=%s\a' "$(__cuaremote_urlencode "$cmd")"
}

PROMPT_COMMAND="__cuaremote_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
PS1="${PS1}\[$(printf '\e]133;B\a')\]"
trap '__cuaremote_preexec' DEBUG
