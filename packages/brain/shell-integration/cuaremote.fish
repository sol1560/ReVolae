# CuaRemote 终端命令分块（fish）
# 用法：在 ~/.config/fish/config.fish 末尾加一行
#   set -q CUAREMOTE_SESSION; and source /path/to/cuaremote.fish
# 标记含义见 cuaremote.zsh。

if set -q CUAREMOTE_SHELL_INTEGRATED
    exit
end
set -g CUAREMOTE_SHELL_INTEGRATED 1

function __cuaremote_urlencode
    string escape --style=url -- $argv[1]
end

function __cuaremote_prompt --on-event fish_prompt
    set -l code $status
    if set -q __cuaremote_running
        printf '\e]133;D;%d\a' $code
        set -e __cuaremote_running
    end
    printf '\e]7;file://%s%s\a' (hostname) (__cuaremote_urlencode $PWD | string replace -a '%2F' '/')
    printf '\e]133;A\a'
end

function __cuaremote_preexec --on-event fish_preexec
    set -g __cuaremote_running 1
    printf '\e]133;C;cmd=%s\a' (__cuaremote_urlencode $argv[1])
end

# B：提示符画完、用户开始输入
functions -q fish_prompt; and functions -c fish_prompt __cuaremote_orig_prompt
function fish_prompt
    __cuaremote_orig_prompt
    printf '\e]133;B\a'
end
