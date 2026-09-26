import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')
const editor = await readFile(new URL('../src/editor/SceneEditorPage.tsx', import.meta.url), 'utf8')

test('guides render in an unscaled screen-space overlay', () => {
  assert.match(editor, /<div className="editor-guide-overlay">/)
  assert.match(css, /\.editor-guide-overlay\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*pointer-events:\s*none;/)
  assert.match(css, /\.device-screen-guide,[^{]+\{[^}]*border:\s*1px solid/)
  assert.doesNotMatch(css.match(/\.editor-guide-overlay\s*\{([^}]+)\}/)?.[1] ?? '', /transform|scale/)
})

test('transformed objects are hit targets without visible guide borders', () => {
  assert.match(css, /\.media-workspace \.device-mask\s*\{[^}]*border:\s*0;[^}]*outline:\s*0;/)
  assert.match(css, /\.media-workspace \.canvas-layer\.selected-layer\s*\{[^}]*border:\s*0;[^}]*outline:\s*0;/)
  assert.match(css, /\.media-workspace\s*\{\s*border:\s*0;/)
  assert.doesNotMatch(css, /\.media-workspace(?:::after| \.device-mask::after| \.canvas-layer\.selected-layer::after)/)
})

test('obsolete zoom-dependent guide geometry variables are gone', () => {
  const sources = `${css}\n${editor}`
  assert.doesNotMatch(sources, /--(?:guide-(?:width|inset|size|scale)|inverse-zoom)\b|calc\([^)]*\/[^)]*zoom|scale\(1\s*\/\s*zoom\)/)
})

test('initial fit and Fit screens both establish a new displayed zoom baseline', () => {
  assert.equal(editor.match(/setFitZoom\(fitted\.zoom\)/g)?.length, 2)
})

test('stale asynchronous device loads cannot overwrite editor-local geometry', () => {
  assert.match(editor, /let cancelled = false/)
  assert.match(editor, /if \(cancelled\) return/)
  assert.match(editor, /return \(\) => \{ cancelled = true \}/)
})
