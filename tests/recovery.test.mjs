import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recoveryDelayMs } from '../src/lib/recovery.ts'

test('recovery backoff grows modestly and remains bounded', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 8].map(recoveryDelayMs), [1000, 2000, 4000, 8000, 8000, 8000])
})
