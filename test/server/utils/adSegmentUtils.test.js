const { expect } = require('chai')

const adSegmentUtils = require('../../../server/utils/adSegmentUtils')

describe('adSegmentUtils', () => {
  describe('normalize', () => {
    it('accepts both start/end and startTime/endTime', () => {
      const result = adSegmentUtils.normalize([
        { start: 10, end: 40 },
        { startTime: 100, endTime: 130 }
      ])
      expect(result).to.have.lengthOf(2)
      expect(result[1].start).to.equal(100)
      expect(result[1].end).to.equal(130)
    })

    it('drops segments with non-numeric or inverted bounds', () => {
      const result = adSegmentUtils.normalize([{ start: 'abc', end: 10 }, { start: 50, end: 40 }, { start: 10, end: 10 }, null, undefined])
      expect(result).to.be.empty
    })

    it('defaults missing confidence and clamps it to 0-1', () => {
      const result = adSegmentUtils.normalize([
        { start: 0, end: 10 },
        { start: 20, end: 30, confidence: 5 },
        { start: 40, end: 50, confidence: -2 }
      ])
      expect(result[0].confidence).to.equal(0.5)
      expect(result[1].confidence).to.equal(1)
      expect(result[2].confidence).to.equal(0)
    })

    it('returns an empty array for non-array input', () => {
      expect(adSegmentUtils.normalize(null)).to.be.empty
      expect(adSegmentUtils.normalize('nope')).to.be.empty
    })
  })

  describe('merge', () => {
    it('merges overlapping segments and keeps the highest confidence', () => {
      const result = adSegmentUtils.merge([
        { start: 10, end: 40, confidence: 0.6, label: 'unknown' },
        { start: 30, end: 60, confidence: 0.9, label: 'unknown' }
      ])
      expect(result).to.have.lengthOf(1)
      expect(result[0]).to.include({ start: 10, end: 60, confidence: 0.9 })
    })

    it('merges segments separated by less than the merge gap', () => {
      const result = adSegmentUtils.merge([
        { start: 0, end: 30, confidence: 0.8, label: 'unknown' },
        { start: 32, end: 60, confidence: 0.8, label: 'unknown' }
      ])
      expect(result).to.have.lengthOf(1)
      expect(result[0].end).to.equal(60)
    })

    it('leaves clearly separate segments alone', () => {
      const result = adSegmentUtils.merge([
        { start: 0, end: 30, confidence: 0.8, label: 'unknown' },
        { start: 300, end: 360, confidence: 0.8, label: 'unknown' }
      ])
      expect(result).to.have.lengthOf(2)
    })

    it('sorts unsorted input before merging', () => {
      const result = adSegmentUtils.merge([
        { start: 300, end: 360, confidence: 0.8, label: 'unknown' },
        { start: 0, end: 30, confidence: 0.8, label: 'unknown' }
      ])
      expect(result[0].start).to.equal(0)
    })
  })

  describe('filterImplausible', () => {
    it('drops segments shorter than the minimum', () => {
      const result = adSegmentUtils.filterImplausible([{ start: 0, end: 3, confidence: 1 }], 3600)
      expect(result).to.be.empty
    })

    it('drops segments longer than a quarter of the episode', () => {
      const result = adSegmentUtils.filterImplausible([{ start: 0, end: 1000, confidence: 1 }], 3600)
      expect(result).to.be.empty
    })

    it('drops segments below the confidence threshold', () => {
      const segments = [{ start: 0, end: 60, confidence: 0.4 }]
      expect(adSegmentUtils.filterImplausible(segments, 3600, 0.7)).to.be.empty
      expect(adSegmentUtils.filterImplausible(segments, 3600, 0.3)).to.have.lengthOf(1)
    })
  })

  describe('clamp', () => {
    it('clamps boundaries into the episode duration', () => {
      const result = adSegmentUtils.clamp([{ start: -10, end: 4000, confidence: 1 }], 3600)
      expect(result[0]).to.include({ start: 0, end: 3600 })
    })

    it('drops segments that clamp to zero length', () => {
      const result = adSegmentUtils.clamp([{ start: 4000, end: 4100, confidence: 1 }], 3600)
      expect(result).to.be.empty
    })
  })

  describe('snapToSilence', () => {
    it('moves boundaries onto nearby silence', () => {
      const result = adSegmentUtils.snapToSilence([{ start: 61, end: 118, confidence: 1 }], [
        { start: 60, end: 60.5 },
        { start: 119.5, end: 120 }
      ])
      expect(result[0].start).to.equal(60)
      expect(result[0].end).to.equal(120)
    })

    it('leaves boundaries alone when silence is too far away', () => {
      const result = adSegmentUtils.snapToSilence([{ start: 61, end: 118, confidence: 1 }], [{ start: 5, end: 6 }])
      expect(result[0]).to.include({ start: 61, end: 118 })
    })

    it('snaps a start that sits just after a silence ends', () => {
      // A transcript line routinely begins a second or two after the real
      // seam, so the near edge of the silence must count as a match.
      const result = adSegmentUtils.snapToSilence([{ start: 125, end: 259, confidence: 1 }], [
        { start: 120, end: 124 },
        { start: 264, end: 268 }
      ])
      expect(result[0].start).to.equal(120)
      // 268 is 9s away, beyond the window, so the reachable near edge wins
      expect(result[0].end).to.equal(264)
    })

    it('never moves a boundary further than the window', () => {
      const result = adSegmentUtils.snapToSilence([{ start: 100, end: 200, confidence: 1 }], [{ start: 20, end: 99 }])
      // The silence ends 1s before the start, but its far edge is 80s away
      expect(result[0].start).to.equal(99)
    })

    it('swallows the whole silence rather than landing inside it', () => {
      const result = adSegmentUtils.snapToSilence([{ start: 122, end: 265, confidence: 1 }], [
        { start: 120, end: 124 },
        { start: 264, end: 268 }
      ])
      expect(result[0].start).to.equal(120)
      expect(result[0].end).to.equal(268)
    })

    it('is a no-op with no silences', () => {
      const segments = [{ start: 61, end: 118, confidence: 1 }]
      expect(adSegmentUtils.snapToSilence(segments, [])).to.deep.equal(segments)
    })
  })

  describe('labelByPosition', () => {
    it('labels by position when the provider gave none', () => {
      const result = adSegmentUtils.labelByPosition(
        [
          { start: 5, end: 60, label: 'unknown' },
          { start: 1000, end: 1060, label: 'unknown' },
          { start: 3550, end: 3600, label: 'unknown' }
        ],
        3600
      )
      expect(result.map((s) => s.label)).to.deep.equal(['preroll', 'midroll', 'postroll'])
    })

    it('keeps a label the provider supplied', () => {
      const result = adSegmentUtils.labelByPosition([{ start: 5, end: 60, label: 'selfpromo' }], 3600)
      expect(result[0].label).to.equal('selfpromo')
    })
  })

  describe('postProcess', () => {
    it('runs the whole pipeline over raw provider output', () => {
      const raw = [
        { start: 11, end: 70, confidence: 0.9 },
        { start: 68, end: 95, confidence: 0.8 },
        { start: 200, end: 202, confidence: 0.95 },
        { start: 500, end: 560, confidence: 0.2 }
      ]
      const result = adSegmentUtils.postProcess(raw, {
        duration: 3600,
        minConfidence: 0.5,
        silences: [{ start: 10, end: 10.5 }]
      })

      // The two overlapping spans merge, the 2s span is too short, and the
      // 0.2 confidence span is below the threshold.
      expect(result).to.have.lengthOf(1)
      expect(result[0].start).to.equal(10)
      expect(result[0].end).to.equal(95)
      expect(result[0].label).to.equal('preroll')
    })

    it('returns an empty array when the provider found nothing', () => {
      expect(adSegmentUtils.postProcess([], { duration: 3600 })).to.be.empty
    })
  })
})

describe('adSegmentUtils confidence threshold', () => {
  it('rejects everything at a threshold no detector can reach', () => {
    // Guards the footgun: detectors cap confidence below 1 on purpose, so a
    // threshold of 1 accepts nothing. ServerSettings clamps it for this reason.
    const segments = adSegmentUtils.postProcess([{ start: 100, end: 160, confidence: 0.95 }], { duration: 3600, minConfidence: 1 })
    expect(segments).to.be.empty
  })

  it('accepts a high-confidence segment at the clamped maximum', () => {
    const segments = adSegmentUtils.postProcess([{ start: 100, end: 160, confidence: 0.95 }], { duration: 3600, minConfidence: 0.95 })
    expect(segments).to.have.lengthOf(1)
  })
})
