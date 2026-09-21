const { expect } = require('chai')

const HeuristicAdDetectionProvider = require('../../../server/providers/addetection/HeuristicAdDetectionProvider')

describe('HeuristicAdDetectionProvider', () => {
  const provider = new HeuristicAdDetectionProvider()

  /**
   * @param {string[]} lines
   */
  function transcript(lines) {
    return {
      segments: lines.map((text, i) => ({ start: i * 5, end: i * 5 + 5, text }))
    }
  }

  it('finds a host-read sponsor block', async () => {
    const result = await provider.detect(
      transcript([
        'welcome back to the show everyone',
        'today we are talking about the news',
        'this episode is brought to you by acme socks',
        'use promo code SHOW for twenty percent off your first order',
        'now back to the episode',
        'so as I was saying'
      ])
    )
    expect(result).to.not.be.empty
    const covered = result.some((segment) => segment.start <= 10 && segment.end >= 20)
    expect(covered).to.be.true
  })

  it('ignores ordinary content', async () => {
    const result = await provider.detect(transcript(['we talked about the weather', 'and then the game went into overtime', 'it was a good night for the home team', 'anyway that is the story']))
    expect(result).to.be.empty
  })

  it('does not fire on a single weak signal alone', async () => {
    const result = await provider.detect(transcript(['head over to the park', 'it was a nice day', 'nothing else happened']))
    expect(result).to.be.empty
  })

  it('returns an empty array for an empty transcript', async () => {
    expect(await provider.detect({ segments: [] })).to.be.empty
    expect(await provider.detect(null)).to.be.empty
  })

  it('emits only the ad copy, not the whole scoring neighbourhood', async () => {
    // Regression: scoring a sliding window and emitting the whole window
    // reported several seconds of real content either side of the read.
    const result = await provider.detect(
      transcript([
        'today my guest has run every peak in the state',
        'and we are going to hear how that went',
        'this episode is brought to you by acme socks, use promo code TRAIL',
        'free trial, cancel anytime, terms and conditions apply',
        'so you were saying something about the ridge line',
        'and how the weather turned about halfway up'
      ])
    )
    expect(result).to.have.lengthOf(1)
    expect(result[0].start).to.equal(10)
    expect(result[0].end).to.equal(20)
  })

  it('treats a return-to-show phrase as the seam, not as ad copy', async () => {
    const result = await provider.detect(
      transcript([
        'this episode is brought to you by acme socks, use promo code TRAIL',
        'free trial, cancel anytime, terms and conditions apply',
        'okay so back to the episode, you were saying about the ridge line',
        'and how the weather turned about halfway up'
      ])
    )
    expect(result).to.have.lengthOf(1)
    // The "back to the episode" line is content resuming, so it stays out
    expect(result[0].end).to.equal(10)
  })

  it('caps confidence below certainty', async () => {
    const result = await provider.detect(transcript(['this episode is sponsored by acme', 'our sponsor acme, use code ACME, free trial, cancel anytime', 'terms and conditions apply']))
    expect(result).to.not.be.empty
    for (const segment of result) {
      expect(segment.confidence).to.be.at.most(0.85)
    }
  })
})
