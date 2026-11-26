LAB_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lab.applescript"
lab() { osascript "$LAB_SCRIPT" "$@"; }

# fp_screen <终端ID>：输出该终端当前屏幕文本。临时占用剪贴板，读完还原原来的文本
fp_screen() {
  local old mark f i
  old=$(pbpaste 2>/dev/null)
  mark="fleetpane-screen-$$-$RANDOM"
  printf '%s' "$mark" | pbcopy
  lab screen "$1" >/dev/null || return 1
  for i in 1 2 3 4 5 6 7 8 9 10; do
    f=$(pbpaste 2>/dev/null)
    [ "$f" != "$mark" ] && break
    sleep 0.1
  done
  # 剪贴板里必须是一个刚生成的文件的路径。不是的话，说明读屏没成功或剪贴板被别人改了：不读，也不还原
  [ "$f" != "$mark" ] && [ -f "$f" ] && [ -n "$(find "$f" -mtime -10s 2>/dev/null)" ] || return 1
  # Ghostty 写的是系统临时目录下的 <随机目录>/screen.txt。别的路径不是它写的，不读
  case "$f" in
    /private/var/folders/*/screen.txt | /var/folders/*/screen.txt | /tmp/*/screen.txt | /private/tmp/*/screen.txt) ;;
    *) return 1 ;;
  esac
  cat "$f"
  [ "$(pbpaste 2>/dev/null)" = "$f" ] && printf '%s' "$old" | pbcopy
  return 0
}

# fp_terms <标签页ID>：列出该标签页里的终端，每行 term= tty= pid=
fp_terms() {
  lab tree | awk -v t="tab=$1 " '/^win=/ { on = index($0, t) > 0; next } on && /term=/ { print $1, $2, $3 }'
}

# fp_focused <标签页ID>：输出该标签页的 focused terminal ID
fp_focused() {
  lab tree | awk -v t="tab=$1 " 'index($0, t) > 0 { for (i = 1; i <= NF; i++) if ($i ~ /^focused=/) print substr($i, 9) }'
}

# fp_state <标签页ID>：一行输出焦点取证用的四元组：前台应用、前台窗口、该标签页是否选中、它的 focused terminal
fp_state() {
  lab tree | awk -v t="tab=$1 " '
    /^frontmost=/ { a = $0 } /^front=/ { b = $0 }
    index($0, t) > 0 { for (i = 1; i <= NF; i++) if ($i ~ /^(selected|focused)=/) c = c " " $i }
    END { print a, b c }'
}

# fp_wait_terms <标签页ID> <期望的终端数> <秒>：轮询直到终端数符合
fp_wait_terms() {
  local end=$((SECONDS + $3))
  until [ "$(fp_terms "$1" | wc -l | tr -d ' ')" -eq "$2" ]; do
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 0.3
  done
}

# fp_winids：列出 Ghostty 各窗口的窗口号，每行一个。新开测试窗口前后各列一次，多出来的那个就是测试窗口
fp_winids() {
  osascript -l JavaScript -e 'ObjC.import("CoreGraphics"); ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0))).filter((w) => w.kCGWindowOwnerName === "Ghostty" && w.kCGWindowLayer === 0 && w.kCGWindowBounds.Height > 100).map((w) => w.kCGWindowNumber).join("\n")'
}

# fp_shot <窗口号> <文件>：只截这一个窗口，不带阴影，不出声
fp_shot() { screencapture -x -o -l "$1" "$2" && chmod 600 "$2"; }

# fp_say <终端ID> <文本>：输入一行并回车。中间停一下，等 Copilot 的输入框（补全弹层）处理完文本
fp_say() { lab type "$1" "$2" >/dev/null && sleep 0.15 && lab key "$1" enter >/dev/null; }

# fp_start <终端ID> [copilot 的额外参数…]：在该终端里用测试目录启动一个 Copilot 会话
fp_start() {
  local t=$1; shift
  # 两个目录都必须指着本次的测试目录。漏设的话，扩展会用上用户真实的目录
  case "$COPILOT_HOME" in /tmp/fleetpane-lab.*/* | /private/tmp/fleetpane-lab.*/*) ;; *) echo "fp_start: COPILOT_HOME 不在测试目录里，不启动" >&2; return 1 ;; esac
  case "$FLEETPANE_RUNTIME_DIR" in /tmp/fleetpane-lab.*/* | /private/tmp/fleetpane-lab.*/*) ;; *) echo "fp_start: FLEETPANE_RUNTIME_DIR 不在测试目录里，不启动" >&2; return 1 ;; esac
  fp_say "$t" "COPILOT_HOME='$COPILOT_HOME' FLEETPANE_RUNTIME_DIR='$FLEETPANE_RUNTIME_DIR' FLEETPANE_LAB_OUT='$OUT' FLEETPANE_DEBUG=${FLEETPANE_DEBUG:-1} copilot --experimental --model claude-fable-5.2 --reasoning-effort medium $*"
}
