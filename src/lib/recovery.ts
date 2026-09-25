export function recoveryDelayMs(attempt: number) {
  return Math.min(1000 * 2 ** Math.max(0, attempt), 8000)
}
