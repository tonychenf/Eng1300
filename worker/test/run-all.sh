#!/usr/bin/env bash
# 全套回归的并行执行器（CR-M9）。
#
#   bash test/run-all.sh                    # 服务端各套 + node 单测，4 路并行
#   bash test/run-all.sh -j 1               # 一套一套串着跑（和以前的 for 循环等价，拿来对照）
#   bash test/run-all.sh --ui               # 再加上浏览器实测那几套
#   bash test/run-all.sh n5-items essay-parse.mjs   # 只跑点名的
#
# 为什么以前不能并行：每套开头都 rm -rf worker/.wrangler，而 wrangler dev 的打包产物固定写在
# worker/.wrangler/tmp——并行时一套的开头会删掉另一套正在用的产物，那套的服务当场卡死
# （cr-auth-limits 把本地库挪到自己的目录之后照样卡，见踩坑记录第十六节）。
# 另外还有三处共享写入：n6-content 重新生成 worker/seed，n5b-assets 往 public/bank 和
# data/ 里写探针文件，ui-rich 也往 data/ 里写。
#
# 所以每套在自己的沙箱里跑：沙箱是一份 repo 的最小副本（worker 的源码、迁移、测试、
# 种子、前端产物，加上 data/、scripts/ 和 web/src），套件看到的 ROOT_DIR、../data、
# ../scripts 全都指向沙箱里的那份。只有 worker/node_modules 是软链（只读不写）。
# **scripts/ 不能软链**：Node 按真实路径算 import.meta.url，build-seed-sql.mjs 和
# build-bank-assets.mjs 会顺着链接找回原仓库，把种子和资源写回原目录。
#
# 开跑时先拍一份快照，各套从快照复制：这一轮测的是开跑那一刻的版本。跑着回归的同时
# 改代码、在原目录 vite build，都不影响这一轮（以前 vite build 会清空正在用的
# worker/public，踩坑记录第十二节附）。
#
# 每套有个超时上限（SUITE_TIMEOUT，默认 1200 秒）：服务卡死时请求会一直挂着
# （踩坑记录第十六节就是七八分钟没有输出），没有上限的话整轮回归陪着一起挂。
#
# 结果判定：退出码为 0、打出了小结、小结里 0 失败、没有出现"!! 读库命令失败"，四条都满足
# 才算过。没有小结的（服务没起来、脚本中途退出）单独点名——没有 FAIL 不等于通过。
set -uo pipefail

WORKER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$WORKER_DIR/.." && pwd)"

# 长的排前面：并行时最后收尾的那套决定总时长，长套先开跑，短套填缝。
# 顺序按 2026-09-30 四路并行实测的各套用时排（n5-items 606 秒、n6-content 543 秒……
# m2-smoke 69 秒）。第一版凭感觉排，cr-h2-publish 和 n3-rebuild 排在最后，
# 其余都跑完了还要等它俩三四分钟。以后加了新套件，按它的实测用时插进来。
SERVER_SUITES=(n5-items n6-content cr-h2-publish n6b-upload n3-rebuild n2-grants m4-smoke
  m5-smoke n3-pack n4-parity m3-smoke n7d-ai-purposes n5b-assets m6-acceptance cr-auth-limits
  prod-e2e-local n1-subjects m2-smoke d1-lib db-isolation)
UI_SUITES=(ui-items ui-rich ui-n6 ui-n6b ui-smoke ui-subjects)   # 同上，按实测用时（94 秒 … 49 秒）
NODE_TESTS=(grade-items.test.mjs rich-text.test.mjs docx-import.test.mjs normalizers.test.mjs
  ai-purposes.test.mjs auth-guard.test.mjs quota-degrade.mjs essay-parse.mjs)

JOBS=4; UI=0; ONLY=()
SUITE_TIMEOUT=${SUITE_TIMEOUT:-1200}
while [ $# -gt 0 ]; do
  case "$1" in
    -j) JOBS=${2:-}; shift 2 ;;
    -j*) JOBS=${1#-j}; shift ;;
    --ui) UI=1; shift ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "不认识的参数：$1（-h 看用法）"; exit 2 ;;
    *) ONLY+=("${1%.sh}"); shift ;;
  esac
done
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || { echo "-j 后面要跟一个正整数，收到的是「$JOBS」"; exit 2; }
[[ "$SUITE_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || { echo "SUITE_TIMEOUT 要是正整数（秒），收到的是「$SUITE_TIMEOUT」"; exit 2; }

if [ ${#ONLY[@]} -gt 0 ]; then
  QUEUE=("${ONLY[@]}")
else
  QUEUE=("${SERVER_SUITES[@]}")
  [ "$UI" = 1 ] && QUEUE+=("${UI_SUITES[@]}")
  QUEUE+=("${NODE_TESTS[@]}")
fi

script_of() { case "$1" in *.mjs) echo "$WORKER_DIR/test/$1" ;; *) echo "$WORKER_DIR/test/$1.sh" ;; esac; }

# ---- 开跑前的检查：跑到一半才发现缺东西，前面的时间就白花了 ----
problems=()
for name in "${QUEUE[@]}"; do
  [ -f "$(script_of "$name")" ] || problems+=("没有这一套：$name（test/ 下找不到 $(basename "$(script_of "$name")")）")
done
# test/ 下每个测试文件都得在上面三张清单之一里。漏登记的套件回归时不会跑，而且不会有任何提示——
# prod-e2e.sh 就是这样一次都没跑成过、四个里程碑没人发现（踩坑记录第十八节）。
# 不是测试的文件（替身、参照物、被 ui-*.sh 调起的浏览器脚本）登记在 NOT_TESTS 里。
NOT_TESTS=(run-all.sh ai-stub.mjs blueprint-reference.mjs)
if [ ${#ONLY[@]} -eq 0 ]; then
  for f in "$WORKER_DIR"/test/*.sh "$WORKER_DIR"/test/*.mjs; do
    b=$(basename "$f"); n=${b%.sh}
    [[ " ${NOT_TESTS[*]} " == *" $b "* ]] && continue
    [[ "$b" == ui-*.mjs ]] && continue
    [[ " ${SERVER_SUITES[*]} ${UI_SUITES[*]} ${NODE_TESTS[*]} " == *" $n "* ]] \
      || problems+=("test/$b 不在任何一张清单里（run-all.sh 开头的 SERVER_SUITES / UI_SUITES / NODE_TESTS），回归时不会跑它")
  done
fi
[ -f "$WORKER_DIR/public/index.html" ] \
  || problems+=("worker/public 不在或不完整（vite 的产物、不进 git）。先跑：npm run build --prefix web && node scripts/build-bank-assets.mjs")
ls "$WORKER_DIR"/seed/english-*.sql >/dev/null 2>&1 \
  || problems+=("worker/seed 里没有英语种子（构建产物、不进 git）。先跑：node scripts/build-seed-sql.mjs")
[ -d "$WORKER_DIR/node_modules" ] || problems+=("worker/node_modules 不在。先跑：npm ci --prefix worker")

# 浏览器实测对 TMPDIR 的长度有上限：Chromium 在 TMPDIR 下建进程单例的 socket，Unix socket 的路径
# 最多 107 字节，TMPDIR 超过 61 个字符就起不来——每套都死在 browserType.launch，报的是
# "Target page, context or browser has been closed"，看不出和路径有关（2026-09-30 实测 61 行、62 不行）。
TMP_BASE=${TMPDIR:-/tmp}
if [ ${#TMP_BASE} -gt 61 ]; then
  for name in "${QUEUE[@]}"; do
    if [[ "$name" == ui-* ]]; then
      problems+=("TMPDIR 太长（${#TMP_BASE} 个字符，浏览器实测上限 61）：Chromium 会起不来。换个短的再跑，比如不设 TMPDIR（用 /tmp）")
      break
    fi
  done
fi

# 端口：并行的前提是每套各用各的。端口表只写在 CLAUDE.md 里，没有东西强制它——
# 新加的套件抄了别人的端口，串行时相安无事，并行时两套抢一个端口，报错像是服务起不来。
#
# 占用情况直接读 /proc/net/tcp（第 4 列 0A 是 LISTEN，第 2 列冒号后是十六进制端口）。
# 本机没有 ss——套件里那句"等端口释放"用的是 ss，找不到命令时 grep 什么也匹配不上，
# 等于从来没等过；这里要是也那么写，检查就是个摆设。读不到就明说查不了。
listening_ports() {
  local f _ addr st
  for f in /proc/net/tcp /proc/net/tcp6; do
    [ -r "$f" ] || continue
    while read -r _ addr _ st _; do
      [ "$st" = 0A ] && echo $((16#${addr##*:}))
    done < <(tail -n +2 "$f")
  done | sort -un
}
if [ -r /proc/net/tcp ]; then
  LISTENING=$(listening_ports)
else
  LISTENING=""
  echo "   （读不到 /proc/net/tcp，查不了端口是否被残留进程占着——这项检查这次没做）"
fi
declare -A PORT_OWNER=()
for name in "${QUEUE[@]}"; do
  f=$(script_of "$name"); [ -f "$f" ] || continue
  for p in $(grep -hoE '^[A-Z_]*PORT=[0-9]+' "$f" | cut -d= -f2); do   # PORT、STUB_PORT、HANG_PORT……
    if [ -n "${PORT_OWNER[$p]:-}" ]; then
      problems+=("端口 $p 同时被 ${PORT_OWNER[$p]} 和 $name 占用，并行时两套会互相踩（端口表见 CLAUDE.md）")
    fi
    PORT_OWNER[$p]=$name
    if grep -qx "$p" <<< "$LISTENING"; then
      problems+=("端口 $p（$name 要用）已经有进程在监听，多半是上一轮残留的 workerd（ps -eo pid,pgid,args | grep '[w]orkerd' 查，kill -- -PGID 收）")
    fi
  done
done
if [ ${#problems[@]} -gt 0 ]; then
  echo "开跑前的检查没过，一套都没跑："
  printf '  - %s\n' "${problems[@]}"
  exit 1
fi

# wrangler 有两处外呼：用量统计上报、取 Request.cf 数据（miniflare 的 setupCf），出站策略都拒绝。
# 代理立刻拒绝时没有影响；代理挂住不回时，d1 execute 把结果打完之后进程不退出、一直等
# （2026-09-30 拿假代理实测：240 秒封顶被杀；两个都关 2.3 秒；只关一个照样挂住）。
# 一轮回归要调几百次 d1 execute，所以两个都关。都是 wrangler / miniflare 自己认的环境变量。
export WRANGLER_SEND_METRICS=false CLOUDFLARE_CF_FETCH_ENABLED=false

RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/xlearn-regress.XXXXXX")
echo "== 全套回归：${#QUEUE[@]} 项，$JOBS 路并行 =="
echo "   日志与沙箱：$RUN_DIR"

# 快照：<RUN_DIR>/.snapshot/repo/{worker,data,scripts,web/src}。沙箱从它复制，不从原目录复制——
# 沙箱是一套开跑时才建的，排在后面的套件要等前面的跑完；从原目录复制的话，
# 这期间原目录里改了什么，后面的套件就测到什么。
SNAP="$RUN_DIR/.snapshot/repo"
mkdir -p "$SNAP/worker" "$SNAP/web" \
  && cp -a "$WORKER_DIR"/{src,migrations,sql,test,seed,public,wrangler.toml,package.json} "$SNAP/worker/" \
  && cp -a "$REPO_DIR/data" "$REPO_DIR/scripts" "$SNAP/" \
  && cp -a "$REPO_DIR/web/src" "$SNAP/web/" \
  || { echo "拍快照失败（$SNAP），一套都没跑"; exit 1; }

# 每项一个沙箱：<RUN_DIR>/<名字>/repo，快照的一份副本加上 node_modules 软链
make_sandbox() {
  local repo="$RUN_DIR/$1/repo"
  mkdir -p "$RUN_DIR/$1" && cp -a "$SNAP" "$repo" || return 1
  ln -s "$WORKER_DIR/node_modules" "$repo/worker/node_modules" || return 1
  # 调试端口也要各用各的：不指定时 wrangler 从 9229 往上探一个空闲的，几套同时启动可能
  # 探到同一个（探的那一刻空闲、真绑的时候被别人抢了），后绑的那个起不来。
  printf '\n# run-all.sh 加的：并行时各套的调试端口不能撞\n[dev]\ninspector_port = %s\n' "$2" >> "$repo/worker/wrangler.toml"
  # 副本里的 database_id 换成一个明显是假的 id（CR-M12）：读库助手服务起来之后走 dev 服务的本地接口，
  # 接口按这个 id 找库，留空的话路径里拼不出来。只动副本，本地用、不部署；真实的 wrangler.toml
  # 必须留空（CLAUDE.md 四之二）——那一行要不是 database_id = ""，这里换不上，就停下别跑。
  sed -i "s/^database_id = \"\"\$/database_id = \"$FAKE_D1_ID\"/" "$repo/worker/wrangler.toml"
  grep -qx "database_id = \"$FAKE_D1_ID\"" "$repo/worker/wrangler.toml" \
    || { echo "!! 沙箱里的 database_id 没换上：真实 wrangler.toml 里那一行不是 database_id = \"\"？"; return 1; }
}
FAKE_D1_ID=00000000-0000-4000-8000-000000000000

run_one() {   # 名字 调试端口 → 结果写到 <RUN_DIR>/<名字>.done：「退出码 秒数」
  local name=$1 start rc pid
  start=$(date +%s)
  if ! make_sandbox "$name" "$2" > "$RUN_DIR/$name.log" 2>&1; then
    echo "!! 沙箱没建成" >> "$RUN_DIR/$name.log"
    echo "97 0" > "$RUN_DIR/$name.done"; return
  fi
  # GNU timeout 会把自己和套件放进一个新的进程组，超时时整组发 TERM（30 秒后还不走就 KILL）。
  # 中途停下时 stop_all 也按这个组来收。套件自己的 EXIT 陷阱会再去收它用 setsid 起的 wrangler dev。
  (
    cd "$RUN_DIR/$name/repo/worker" || exit 98
    export D1_TRACE="$RUN_DIR/$name.d1trace"   # 读库助手每次走了哪条路（接口 / 命令）
    case "$name" in
      *.mjs) exec timeout -k 30 "$SUITE_TIMEOUT" node "test/$name" ;;
      *)     exec timeout -k 30 "$SUITE_TIMEOUT" bash "test/$name.sh" ;;
    esac
  ) >> "$RUN_DIR/$name.log" 2>&1 < /dev/null &
  pid=$!
  echo "$pid" > "$RUN_DIR/$name.pid"
  wait "$pid"; rc=$?
  # 各套的 dev 日志写在 /tmp 的固定路径（DEV_LOG=/tmp/xx-dev.log），下一次跑同一套就被覆盖。
  # 跑完立刻拷一份进本轮目录，失败时汇总里贴它的尾巴——n6b-upload 有一次 wrangler dev 中途崩了，
  # 崩溃现场差点被随后的重跑冲掉（踩坑记录第二十节）。
  local devlog
  devlog=$(grep -m1 -oE '^DEV_LOG=[^ ]+' "$RUN_DIR/$name/repo/worker/test/$name.sh" 2>/dev/null | cut -d= -f2)
  [ -n "$devlog" ] && [ -f "$devlog" ] && cp "$devlog" "$RUN_DIR/$name.dev.log"
  echo "$rc $(( $(date +%s) - start ))" > "$RUN_DIR/$name.done"
}

stop_all() {
  echo; echo "!! 收到中断，停掉还在跑的套件……"
  for f in "$RUN_DIR"/*.pid; do
    [ -f "$f" ] || continue
    local n; n=$(basename "$f" .pid)
    [ -f "$RUN_DIR/$n.done" ] || kill -TERM -- "-$(cat "$f")" 2>/dev/null
  done
  wait
  exit 130
}
trap stop_all INT TERM

# 从日志里取结论。输出：通过数 失败数 有没有小结(1/0) 读库失败次数
verdict_of() {
  local log="$RUN_DIR/$1.log" line p f
  # 只认顶格的小结：prod-e2e-local 会把它调起的 prod-e2e.sh 的小结缩进着转印出来，
  # 那几行不是这一套自己的结论（它自己没跑完时尤其不能拿来顶替）。
  line=$(grep -E '^== 小结: *[0-9]+ 通过, *[0-9]+ 失败' "$log" | tail -1)
  if [ -n "$line" ]; then
    p=$(sed -E 's/.*小结: *([0-9]+) 通过.*/\1/' <<< "$line")
    f=$(sed -E 's/.*通过, *([0-9]+) 失败.*/\1/' <<< "$line")
    echo "$p $f 1 $(grep -c '!! 读库命令失败' "$log")"
  else
    echo "- - 0 $(grep -c '!! 读库命令失败' "$log")"
  fi
}

ok_of() {   # 名字 → 0 表示四条都满足
  local rc secs p f has rf
  read -r rc secs < "$RUN_DIR/$1.done"
  read -r p f has rf <<< "$(verdict_of "$1")"
  [ "$rc" = 0 ] && [ "$has" = 1 ] && [ "$f" = 0 ] && [ "$rf" = 0 ]
}

declare -A REPORTED=()
DONE=0; TOTAL=${#QUEUE[@]}
report_finished() {
  local name rc secs p f has rf mark
  for name in "${QUEUE[@]}"; do
    [ -n "${REPORTED[$name]:-}" ] && continue
    [ -f "$RUN_DIR/$name.done" ] || continue
    REPORTED[$name]=1; DONE=$((DONE+1))
    read -r rc secs < "$RUN_DIR/$name.done"
    read -r p f has rf <<< "$(verdict_of "$name")"
    if ok_of "$name"; then mark="通过"; rm -rf "${RUN_DIR:?}/$name"; else mark="!! 有问题"; fi
    # 中文按字节算宽，printf 的 %-Ns 对不齐——所以要对齐的列只放 ASCII，中文放在最后
    printf '  [%2d/%d] %-22s %5ss  断言 %4s 过 %3s 败  %s\n' "$DONE" "$TOTAL" "$name" "$secs" "$p" "$f" "$mark"
  done
}

T0=$(date +%s)
running=0; port=9300
for name in "${QUEUE[@]}"; do
  while [ "$running" -ge "$JOBS" ]; do
    wait -n; running=$((running-1)); report_finished
  done
  run_one "$name" "$port" &
  running=$((running+1)); port=$((port+1))
done
while [ "$running" -gt 0 ]; do
  wait -n; running=$((running-1)); report_finished
done
report_finished
WALL=$(( $(date +%s) - T0 ))

# ---- 汇总 ----
echo
echo "套件                     通过  失败  退出码   用时  结论"
bad=(); sum=0; npass=0
for name in "${QUEUE[@]}"; do
  read -r rc secs < "$RUN_DIR/$name.done"
  read -r p f has rf <<< "$(verdict_of "$name")"
  sum=$((sum+secs)); [ "$p" != - ] && npass=$((npass+p))
  note=()
  { [ "$rc" = 124 ] || [ "$rc" = 137 ]; } && note+=("超时（$SUITE_TIMEOUT 秒没跑完，被停掉）")
  [ "$has" = 1 ] || note+=("没有小结（没跑到结论，看日志尾部）")
  [ "$rf" = 0 ] || note+=("读库失败 $rf 次")
  [ "$rc" = 0 ] || [ "$has" = 0 ] || [ "$f" != 0 ] || note+=("小结 0 失败但退出码 $rc")
  if ok_of "$name"; then res=通过; else res=有问题; bad+=("$name"); fi
  joined=""; for n in "${note[@]}"; do joined+="${joined:+；}$n"; done
  printf '%-22s %6s %5s %7s %5ss  %s\n' "$name" "$p" "$f" "$rc" "$secs" "$res${joined:+：$joined}"
done
echo
echo "合计 ${#QUEUE[@]} 项，通过断言 $npass 条；用时 $((WALL/60)) 分 $((WALL%60)) 秒（各项累计 $((sum/60)) 分 $((sum%60)) 秒）"
# 走接口的次数突然掉到 0（比如 wrangler 升级后本地接口换了路径），各套照样全绿、只是变慢——
# 所以把走向摆在汇总里，一眼看得出来
n_http=$(cat "$RUN_DIR"/*.d1trace 2>/dev/null | grep -c '^http' || true)
n_cli=$(cat "$RUN_DIR"/*.d1trace 2>/dev/null | grep -c '^cli' || true)
echo "读库助手：走本地接口 ${n_http:-0} 次、走 wrangler d1 execute ${n_cli:-0} 次（迁移、导种子这些直接调命令的不在内）"

rm -rf "$RUN_DIR/.snapshot"
if [ ${#bad[@]} -eq 0 ]; then
  echo "== 全部通过 ==（各项日志留在 $RUN_DIR）"
  exit 0
fi

echo "== 有问题的 ${#bad[@]} 项：${bad[*]} =="
for name in "${bad[@]}"; do
  echo "--- $name（日志 $RUN_DIR/$name.log，沙箱保留在 $RUN_DIR/$name）"
  # 同理只列这一套自己的 FAIL（两格缩进），不列转印进来的；一行都没有（没跑到结论、
  # 或者小结 0 失败而退出码不为 0）就看日志尾部
  lines=$(grep -E '^  FAIL|^ *!! 读库命令失败|^!! ' "$RUN_DIR/$name.log" | head -20)
  [ -n "$lines" ] || lines=$(tail -15 "$RUN_DIR/$name.log")
  printf '%s\n' "$lines" | sed 's/^/   /'
  # 服务中途挂掉时，断言全是"实际 000"，真正的原因只在 dev 日志里
  if [ -f "$RUN_DIR/$name.dev.log" ]; then
    echo "   dev 日志尾部（全文 $RUN_DIR/$name.dev.log）："
    tail -6 "$RUN_DIR/$name.dev.log" | cut -c1-200 | sed 's/^/     /'
  fi
done
exit 1
