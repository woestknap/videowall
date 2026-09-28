#!/bin/bash
# ScreenMesh local video converter for macOS.
# Double-click this file to choose one video, or run it in Terminal with files/folders as arguments.
set -u

ffmpeg_bin="$(command -v ffmpeg || true)"
ffprobe_bin="$(command -v ffprobe || true)"
profile_name='ScreenMesh V1: H.264 High@4.1, yuv420p, CRF 20, max 1920x1080, max 30 fps, AAC 160k'
passed=0; failed=0; skipped=0

if [[ -z "$ffmpeg_bin" || -z "$ffprobe_bin" ]]; then
  echo 'FFmpeg and ffprobe are required but were not found.'
  echo 'Install Homebrew if needed, then run: brew install ffmpeg'
  exit 2
fi

if [[ $# -eq 0 ]]; then
  selected_file="$(osascript -e 'POSIX path of (choose file with prompt "Choose a video to convert for ScreenMesh")' 2>/dev/null || true)"
  if [[ -z "$selected_file" ]]; then echo 'No file selected.'; exit 1; fi
  set -- "$selected_file"
fi

video_info() {
  "$ffprobe_bin" -v error -select_streams v:0 -show_entries stream=codec_name,profile,width,height,avg_frame_rate -show_entries format=duration -of default=noprint_wrappers=1 -- "$1" 2>/dev/null
}

output_path() {
  local source="$1" directory stem candidate duplicate
  directory="$(dirname "$source")/ScreenMesh Converted"
  mkdir -p "$directory"
  stem="$(basename "$source")"; stem="${stem%.*}"
  candidate="$directory/$stem.screenmesh.mp4"; duplicate=2
  while [[ -e "$candidate" ]]; do candidate="$directory/$stem.screenmesh ($duplicate).mp4"; duplicate=$((duplicate + 1)); done
  printf '%s\n' "$candidate"
}

convert_file() {
  local source="$1" info output temporary output_info size
  [[ "$(basename "$source")" == *.screenmesh.mp4 || "$(dirname "$source")" == */"ScreenMesh Converted" ]] && { echo "SKIPPED  $source"; skipped=$((skipped + 1)); return; }
  info="$(video_info "$source")"
  [[ "$info" != *'codec_name='* ]] && { echo "SKIPPED  $(basename "$source") (no readable video stream)"; skipped=$((skipped + 1)); return; }
  echo "Input: $(basename "$source")"; echo "$info" | sed 's/^/  /'
  output="$(output_path "$source")"; temporary="${output%.mp4}.partial.mp4"
  if "$ffmpeg_bin" -hide_banner -y -i "$source" -map 0:v:0 -map '0:a?' -c:v libx264 -profile:v high -level:v 4.1 -pix_fmt yuv420p -preset medium -crf 20 -maxrate 12M -bufsize 24M -vf "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2" -fpsmax 30 -c:a aac -b:a 160k -movflags +faststart "$temporary"; then
    mv "$temporary" "$output"
    output_info="$(video_info "$output")"; size="$(stat -f %z "$output" 2>/dev/null || echo '?')"
    echo "PASS     $output — $output_info — $size bytes"; passed=$((passed + 1))
  else
    rm -f "$temporary"; echo "FAILED   $(basename "$source")"; failed=$((failed + 1))
  fi
}

process_input() {
  local input="$1" file
  if [[ -d "$input" ]]; then
    while IFS= read -r -d '' file; do convert_file "$file"; done < <(find "$input" -type f -not -path '*/ScreenMesh Converted/*' -not -name '*.screenmesh.mp4' -print0)
  elif [[ -f "$input" ]]; then convert_file "$input"
  else echo "FAILED   $input (path not found)"; failed=$((failed + 1)); fi
}

echo "ScreenMesh local converter — $profile_name"
for input in "$@"; do process_input "$input"; done
echo "Finished: PASS $passed  FAILED $failed  SKIPPED $skipped"
[[ $failed -eq 0 ]]
