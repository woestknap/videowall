import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeReceiverStats, normalizeSenderStats } from '../src/lib/livePerformanceStats.ts'

const sender = (bytesSent, framesEncoded) => [
  { id: 'outbound', type: 'outbound-rtp', kind: 'video', bytesSent, packetsSent: 20, framesEncoded, framesSent: framesEncoded, framesPerSecond: 30, qualityLimitationReason: 'none', qualityLimitationDurations: { cpu: 0 }, targetBitrate: 2_000_000, retransmittedPacketsSent: 1, retransmittedBytesSent: 20 },
  { id: 'pair', type: 'candidate-pair', selected: true, localCandidateId: 'local', availableOutgoingBitrate: 3_000_000, currentRoundTripTime: .023 },
  { id: 'local', type: 'local-candidate', candidateType: 'host', address: '192.168.1.44' },
]
const receiver = (bytesReceived, framesReceived, packetsReceived, packetsLost) => [
  { id: 'inbound', type: 'inbound-rtp', kind: 'video', bytesReceived, packetsReceived, packetsLost, jitter: .014, framesReceived, framesDecoded: framesReceived - 1, framesDropped: 2, framesPerSecond: 30, totalDecodeTime: 1.2, keyFramesDecoded: 3 },
  { id: 'pair', type: 'candidate-pair', selected: true, localCandidateId: 'local', currentRoundTripTime: .02 },
  { id: 'local', type: 'local-candidate', candidateType: 'srflx', address: '203.0.113.10' },
]

test('sender and receiver stats derive safe rolling rates and transport summaries', () => {
  const firstSender = normalizeSenderStats(sender(1_000, 10), undefined, 1_000)
  const nextSender = normalizeSenderStats(sender(251_000, 40), firstSender.snapshot, 2_000)
  assert.equal(nextSender.stats.outboundMbps, 2)
  assert.equal(nextSender.stats.encodedFps, 30)
  assert.equal(nextSender.stats.candidateType, 'host')
  assert.equal(nextSender.stats.roundTripTimeMs, 23)
  const firstReceiver = normalizeReceiverStats(receiver(1_000, 10, 100, 0), undefined, 1_000)
  const nextReceiver = normalizeReceiverStats(receiver(251_000, 40, 190, 10), firstReceiver.snapshot, 2_000)
  assert.equal(nextReceiver.stats.inboundMbps, 2)
  assert.equal(nextReceiver.stats.receiveFps, 30)
  assert.equal(nextReceiver.stats.packetLossPercent, 10)
  assert.equal(nextReceiver.stats.jitterMs, 14)
  assert.equal(nextReceiver.stats.candidateType, 'srflx')
  assert.doesNotMatch(JSON.stringify(nextReceiver.stats), /192\.168|203\.0\.113|address/)
})

test('missing, reset, and incomplete browser stats remain safe', () => {
  assert.equal(normalizeSenderStats([], undefined, 1_000).stats.outboundMbps, undefined)
  assert.equal(normalizeReceiverStats([], undefined, 1_000).stats.inboundMbps, undefined)
  const previous = normalizeReceiverStats(receiver(1_000, 10, 100, 5), undefined, 1_000)
  const reset = normalizeReceiverStats(receiver(10, 1, 1, 0), previous.snapshot, 2_000)
  assert.equal(reset.stats.inboundMbps, undefined)
  assert.equal(reset.stats.packetLossPercent, undefined)
})
