export type CaptureSettings = { width?: number; height?: number; frameRate?: number; deviceId?: string }
export type SenderPerformanceStats = { outboundMbps?: number; encodedFps?: number; bytesSent?: number; packetsSent?: number; framesEncoded?: number; framesSent?: number; framesPerSecond?: number; totalEncodeTime?: number; qualityLimitationReason?: string; qualityLimitationDurations?: Record<string, number>; retransmittedPacketsSent?: number; retransmittedBytesSent?: number; targetBitrate?: number; availableOutgoingBitrate?: number; roundTripTimeMs?: number; candidateType?: string }
export type ReceiverPerformanceStats = { inboundMbps?: number; receiveFps?: number; bytesReceived?: number; packetsReceived?: number; packetsLost?: number; packetLossPercent?: number; jitterMs?: number; framesReceived?: number; framesDecoded?: number; framesDropped?: number; framesPerSecond?: number; totalDecodeTime?: number; keyFramesDecoded?: number; roundTripTimeMs?: number; candidateType?: string; statsEntries?: number; videoReceivers?: number; inboundVideoStatsAvailable?: boolean; presentationFps?: number }
export type ReceiverStatsContext = { receiverReport?: Iterable<unknown>; statsEntries?: number; videoReceivers?: number }
type Snapshot = { at: number; bytes?: number; frames?: number; packetsReceived?: number; packetsLost?: number }
type Stat = Record<string, unknown>

const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const text = (value: unknown) => typeof value === 'string' ? value : undefined
const entries = (report: Iterable<unknown>) => [...report].map(value => Array.isArray(value) ? value[1] : value).filter((value): value is Stat => !!value && typeof value === 'object')
const video = (entry: Stat, type: string) => entry.type === type && (entry.kind === 'video' || entry.mediaType === 'video')
const rate = (current: number | undefined, previous: number | undefined, elapsedMs: number) => current === undefined || previous === undefined || elapsedMs <= 0 || current < previous ? undefined : (current - previous) / elapsedMs
const selectedPair = (items: Stat[]) => {
  const transport = items.find(item => item.type === 'transport' && typeof item.selectedCandidatePairId === 'string')
  return items.find(item => item.type === 'candidate-pair' && (item.selected === true || item.id === transport?.selectedCandidatePairId))
}
const candidateType = (items: Stat[], pair: Stat | undefined) => text(items.find(item => item.type === 'local-candidate' && item.id === pair?.localCandidateId)?.candidateType)
const transport = (items: Stat[]) => { const pair = selectedPair(items); return { pair, candidateType: candidateType(items, pair), roundTripTimeMs: number(pair?.currentRoundTripTime) === undefined ? undefined : number(pair?.currentRoundTripTime)! * 1000, availableOutgoingBitrate: number(pair?.availableOutgoingBitrate) } }
export const mergeStatsReports = (reports: Iterable<Iterable<unknown>>) => [...reports].flatMap(report => [...report])

export function captureSettings(track: MediaStreamTrack): CaptureSettings { const settings = track.getSettings(); return { width: settings.width, height: settings.height, frameRate: settings.frameRate, deviceId: settings.deviceId } }
export function normalizeSenderStats(report: Iterable<unknown>, previous?: Snapshot, at = Date.now()) {
  const items = entries(report); const stat = items.find(item => video(item, 'outbound-rtp')); const network = transport(items); if (!stat) return { stats: { candidateType: network.candidateType, roundTripTimeMs: network.roundTripTimeMs, availableOutgoingBitrate: network.availableOutgoingBitrate } satisfies SenderPerformanceStats, snapshot: { at } satisfies Snapshot }
  const bytesSent = number(stat.bytesSent); const framesEncoded = number(stat.framesEncoded); const elapsed = at - (previous?.at ?? at)
  const stats: SenderPerformanceStats = { bytesSent, packetsSent: number(stat.packetsSent), framesEncoded, framesSent: number(stat.framesSent), framesPerSecond: number(stat.framesPerSecond), totalEncodeTime: number(stat.totalEncodeTime), qualityLimitationReason: text(stat.qualityLimitationReason), qualityLimitationDurations: typeof stat.qualityLimitationDurations === 'object' && stat.qualityLimitationDurations ? Object.fromEntries(Object.entries(stat.qualityLimitationDurations as Record<string, unknown>).flatMap(([key, value]) => number(value) === undefined ? [] : [[key, number(value)!]])) : undefined, retransmittedPacketsSent: number(stat.retransmittedPacketsSent), retransmittedBytesSent: number(stat.retransmittedBytesSent), targetBitrate: number(stat.targetBitrate), availableOutgoingBitrate: network.availableOutgoingBitrate, roundTripTimeMs: network.roundTripTimeMs, candidateType: network.candidateType }
  const bytesPerMs = rate(bytesSent, previous?.bytes, elapsed); const framesPerMs = rate(framesEncoded, previous?.frames, elapsed)
  if (bytesPerMs !== undefined) stats.outboundMbps = bytesPerMs * 8 / 1000
  if (framesPerMs !== undefined) stats.encodedFps = framesPerMs * 1000
  return { stats, snapshot: { at, bytes: bytesSent, frames: framesEncoded } satisfies Snapshot }
}

export function normalizeReceiverStats(report: Iterable<unknown>, previous?: Snapshot, at = Date.now(), context: ReceiverStatsContext = {}) {
  const items = entries(report); const receiverItems = context.receiverReport ? entries(context.receiverReport) : []; const stat = receiverItems.find(item => video(item, 'inbound-rtp')) ?? receiverItems.find(item => item.type === 'inbound-rtp') ?? items.find(item => video(item, 'inbound-rtp')); const network = transport(items); if (!stat) return { stats: { candidateType: network.candidateType, roundTripTimeMs: network.roundTripTimeMs, statsEntries: context.statsEntries ?? items.length, videoReceivers: context.videoReceivers, inboundVideoStatsAvailable: false } satisfies ReceiverPerformanceStats, snapshot: { at } satisfies Snapshot }
  const bytesReceived = number(stat.bytesReceived); const framesReceived = number(stat.framesReceived); const packetsReceived = number(stat.packetsReceived); const packetsLost = number(stat.packetsLost); const elapsed = at - (previous?.at ?? at)
  const stats: ReceiverPerformanceStats = { bytesReceived, packetsReceived, packetsLost, jitterMs: number(stat.jitter) === undefined ? undefined : number(stat.jitter)! * 1000, framesReceived, framesDecoded: number(stat.framesDecoded), framesDropped: number(stat.framesDropped), framesPerSecond: number(stat.framesPerSecond), totalDecodeTime: number(stat.totalDecodeTime), keyFramesDecoded: number(stat.keyFramesDecoded), roundTripTimeMs: network.roundTripTimeMs, candidateType: network.candidateType, statsEntries: context.statsEntries ?? items.length, videoReceivers: context.videoReceivers, inboundVideoStatsAvailable: true }
  const bytesPerMs = rate(bytesReceived, previous?.bytes, elapsed); const framesPerMs = rate(framesReceived, previous?.frames, elapsed)
  if (bytesPerMs !== undefined) stats.inboundMbps = bytesPerMs * 8 / 1000
  if (framesPerMs !== undefined) stats.receiveFps = framesPerMs * 1000
  const receivedDelta = packetsReceived === undefined || previous?.packetsReceived === undefined ? undefined : packetsReceived - previous.packetsReceived; const lostDelta = packetsLost === undefined || previous?.packetsLost === undefined ? undefined : packetsLost - previous.packetsLost
  if (receivedDelta !== undefined && lostDelta !== undefined && receivedDelta >= 0 && lostDelta >= 0 && receivedDelta + lostDelta > 0) stats.packetLossPercent = lostDelta / (receivedDelta + lostDelta) * 100
  return { stats, snapshot: { at, bytes: bytesReceived, frames: framesReceived, packetsReceived, packetsLost } satisfies Snapshot }
}

export const compactMetric = (value: number | undefined, digits = 1) => value === undefined ? '—' : value.toFixed(digits)
