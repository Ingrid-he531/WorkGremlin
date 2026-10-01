#!/usr/bin/env bash
#
# make-demo-gif.sh —— 把录好的演示视频压成 README 里的 GIF。
#
# 配套 scripts/record-demo.py（那个负责录，这个负责转）。默认读 recordings/ 里最新的一段，
# 输出到 docs/assets/demo.gif —— README 的「演示」一节引的就是它。
#
# 用法：
#   scripts/make-demo-gif.sh                          # recordings 里最新一段 → docs/assets/demo.gif
#   scripts/make-demo-gif.sh recordings/xxx.mp4       # 指定输入
#   scripts/make-demo-gif.sh in.mp4 out.gif 12 900 128  # 输入 输出 帧率 宽度 配色数
#
# 三步（都是为了让 README 里的字看得清、体积又别太大）：
#   1) cropdetect 自动认出窗口、把录屏四周的黑边裁掉（1920×1080 的整屏录制，窗口只占一角）；
#   2) palettegen 先按整段画面的颜色统计生成调色板（GIF 只有 256 色，不这么做会有色带）；
#   3) paletteuse 用那块调色板把视频转成 GIF，bayer 抖动（对 UI 文字最友好、也比 sierra 小）。
#
# 依赖：ffmpeg（含 ffprobe）。
set -euo pipefail

cd "$(dirname "$0")/.."

IN="${1:-}"
OUT="${2:-docs/assets/demo.gif}"
FPS="${3:-15}"
WIDTH="${4:-1000}"
COLORS="${5:-256}"

# 没给输入就挑 recordings/ 里最新的那段
if [ -z "$IN" ]; then
  IN="$(ls -t recordings/*.mp4 recordings/*.mkv recordings/*.webm 2>/dev/null | head -1 || true)"
fi
if [ -z "$IN" ] || [ ! -f "$IN" ]; then
  echo "找不到输入视频。先录一段：scripts/record-demo.py -d 30" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
PAL="$(mktemp -t wg-palette-XXXXXX.png)"
trap 'rm -f "$PAL"' EXIT

# 1) 黑边裁掉：录 2~5 秒那段（窗口已经稳定）跑 cropdetect，取最后给出的 crop 参数
CROP="$(ffmpeg -v info -ss 2 -t 3 -i "$IN" -vf cropdetect=24:2:0 -f null - 2>&1 \
  | grep -o 'crop=[0-9:]*' | tail -1 || true)"
if [ -z "$CROP" ]; then
  echo "cropdetect 没认出可裁区域，按整幅画面转（若是整屏录制，GIF 会偏大）" >&2
  CROP="crop=iw:ih:0:0"
fi
echo "[1/3] 裁剪：$CROP"

VF="fps=${FPS},${CROP},scale=${WIDTH}:-1:flags=lanczos"

echo "[2/3] 生成调色板（${COLORS} 色）…"
ffmpeg -v error -i "$IN" -vf "${VF},palettegen=max_colors=${COLORS}:stats_mode=diff" -y "$PAL"

echo "[3/3] 转 GIF → $OUT"
ffmpeg -v error -i "$IN" -i "$PAL" \
  -lavfi "${VF}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
  -y "$OUT"

SIZE="$(du -h "$OUT" | cut -f1)"
echo "完成：$OUT（$SIZE）"
echo "直接提交就行 —— README 的「演示」一节引的就是这个路径。"
