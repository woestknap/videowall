export type ScenePreparationOutcome = 'READY' | 'ERROR'

/**
 * Tracks one local attempt to prepare a scene before a synchronized activation.
 * The attempt stays pending until its readiness RPC succeeds, so a transient
 * network failure can be retried without reloading the media.
 */
export type ScenePreparationAttempt = {
  key: string
  outcome: ScenePreparationOutcome | null
  detail: string | null
  reporting: boolean
  reported: boolean
}

export function createScenePreparationAttempt(key: string): ScenePreparationAttempt {
  return { key, outcome: null, detail: null, reporting: false, reported: false }
}

export function scenePreparationNeedsStart(attempt: ScenePreparationAttempt | null, key: string) {
  return attempt?.key !== key
}

export function scenePreparationNeedsReport(attempt: ScenePreparationAttempt | null) {
  return Boolean(attempt?.outcome && !attempt.reporting && !attempt.reported)
}
