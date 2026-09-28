export const SCREENMESH_CONVERTER_PROFILE = {
  maxWidth: 1920,
  maxHeight: 1080,
  maxFrameRate: 30,
  videoCodec: 'libx264',
  pixelFormat: 'yuv420p',
  h264Profile: 'high',
  h264Level: '4.1',
  crf: 20,
  maxRate: '12M',
  bufferSize: '24M',
  audioCodec: 'aac',
  audioBitrate: '160k',
} as const

export function convertedFilename(filename: string, duplicate = 1) {
  const stem = filename.replace(/\.[^.]*$/, '') || filename
  const suffix = duplicate > 1 ? ` (${duplicate})` : ''
  return `${stem}.screenmesh${suffix}.mp4`
}

export function shouldSkipConverterInput(filename: string, inConvertedDirectory = false) {
  return inConvertedDirectory || filename.toLowerCase().endsWith('.screenmesh.mp4')
}

export function screenMeshVideoDimensions(width: number, height: number) {
  if (![width, height].every(value => Number.isFinite(value) && value > 0)) return null
  const scale = Math.min(1, SCREENMESH_CONVERTER_PROFILE.maxWidth / width, SCREENMESH_CONVERTER_PROFILE.maxHeight / height)
  const even = (value: number) => Math.floor(value / 2) * 2
  const outputWidth = even(width * scale)
  const outputHeight = even(height * scale)
  return outputWidth >= 2 && outputHeight >= 2 ? { width: outputWidth, height: outputHeight } : null
}

export function cappedFrameRate(frameRate: number) {
  return Number.isFinite(frameRate) && frameRate > 0 ? Math.min(frameRate, SCREENMESH_CONVERTER_PROFILE.maxFrameRate) : null
}

export function screenMeshFfmpegArguments(input: string, output: string) {
  const profile = SCREENMESH_CONVERTER_PROFILE
  return [
    '-hide_banner', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a?',
    '-c:v', profile.videoCodec, '-profile:v', profile.h264Profile, '-level:v', profile.h264Level,
    '-pix_fmt', profile.pixelFormat, '-preset', 'medium', '-crf', String(profile.crf),
    '-maxrate', profile.maxRate, '-bufsize', profile.bufferSize,
    '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-fpsmax', String(profile.maxFrameRate), '-c:a', profile.audioCodec, '-b:a', profile.audioBitrate,
    '-movflags', '+faststart', output,
  ]
}
