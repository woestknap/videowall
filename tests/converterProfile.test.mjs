import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { cappedFrameRate, convertedFilename, screenMeshFfmpegArguments, screenMeshVideoDimensions, shouldSkipConverterInput } from '../src/lib/converterProfile.ts'

test('converter output names are sibling-safe and skip previous ScreenMesh output', () => {
  assert.equal(convertedFilename('presentation.mov'), 'presentation.screenmesh.mp4')
  assert.equal(convertedFilename('presentation.mov', 2), 'presentation.screenmesh (2).mp4')
  assert.equal(shouldSkipConverterInput('presentation.screenmesh.mp4'), true)
  assert.equal(shouldSkipConverterInput('presentation.mov', true), true)
  assert.equal(shouldSkipConverterInput('presentation.mov'), false)
})

test('converter scaling never upscales, caps the bounding box, and uses even dimensions', () => {
  assert.deepEqual(screenMeshVideoDimensions(413, 325), { width: 412, height: 324 })
  assert.deepEqual(screenMeshVideoDimensions(3840, 2160), { width: 1920, height: 1080 })
  assert.deepEqual(screenMeshVideoDimensions(4000, 1000), { width: 1920, height: 480 })
  assert.equal(screenMeshVideoDimensions(1, 1), null)
})

test('converter caps high frame rates while retaining lower frame rates', () => {
  assert.equal(cappedFrameRate(24), 24)
  assert.equal(cappedFrameRate(30), 30)
  assert.equal(cappedFrameRate(59.94), 30)
  assert.equal(cappedFrameRate(0), null)
})

test('converter command uses the documented Pi-friendly MP4 profile', () => {
  const args = screenMeshFfmpegArguments('input.mov', 'output.partial.mp4')
  for (const expected of ['-c:v', 'libx264', '-profile:v', 'high', '-level:v', '4.1', '-pix_fmt', 'yuv420p', '-crf', '20', '-fpsmax', '30', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart']) assert.ok(args.includes(expected))
  assert.ok(args.includes("scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"))
})

test('public converter scripts remain local-only and include dependency guidance', () => {
  const launcher = readFileSync(new URL('../public/downloads/ScreenMesh-Convert-Windows.cmd', import.meta.url), 'utf8')
  const windows = readFileSync(new URL('../public/downloads/ScreenMesh-Convert-Windows.ps1', import.meta.url), 'utf8')
  const macos = readFileSync(new URL('../public/downloads/ScreenMesh-Convert-macOS.command', import.meta.url), 'utf8')
  for (const script of [windows, macos]) {
    assert.match(script, /ffmpeg/)
    assert.match(script, /ffprobe/)
    assert.match(script, /ScreenMesh Converted/)
    assert.match(script, /partial\.mp4/)
    assert.doesNotMatch(script, /https?:\/\//)
  }
  assert.match(windows, /winget install Gyan\.FFmpeg/)
  assert.match(macos, /brew install ffmpeg/)
  assert.match(launcher, /ScreenMesh-Convert-Windows\.ps1/)
  assert.match(launcher, /%\*/)
  assert.doesNotMatch(windows, /[^\x00-\x7F]/)
  assert.doesNotMatch(launcher, /[^\x00-\x7F]/)
})

test('unauthenticated sign-in page exposes only converter downloads', () => {
  const page = readFileSync(new URL('../src/admin/SignIn.tsx', import.meta.url), 'utf8')
  assert.match(page, /ScreenMesh conversion tools/)
  assert.match(page, /href="\/downloads\/ScreenMesh-Convert-Windows\.zip"/)
  assert.match(page, /href="\/downloads\/ScreenMesh-Convert-macOS\.command"/)
  assert.doesNotMatch(page, /MediaLibrary|Admin/)
})

test('authenticated dashboard signs out through Supabase and reuses the public converter downloads', () => {
  const dashboard = readFileSync(new URL('../src/admin/Admin.tsx', import.meta.url), 'utf8')
  assert.match(dashboard, /supabase\.auth\.signOut\(\)/)
  assert.match(dashboard, /Could not sign out:/)
  assert.match(dashboard, />Sign out<\/button>/)
  assert.match(dashboard, /href="\/downloads\/ScreenMesh-Convert-Windows\.zip"/)
  assert.match(dashboard, /href="\/downloads\/ScreenMesh-Convert-macOS\.command"/)
})
