const { expect } = require('chai')
const sinon = require('sinon')
const axios = require('axios')

const LlmAdDetectionProvider = require('../../../server/providers/addetection/LlmAdDetectionProvider')

describe('LlmAdDetectionProvider', () => {
  /**
   * @param {number} count
   * @param {number} [step]
   */
  function buildSegments(count, step = 5) {
    return Array.from({ length: count }, (_, i) => ({ start: i * step, end: i * step + step, text: `line ${i}` }))
  }

  describe('defaults', () => {
    it('defaults to DeepSeek', () => {
      const provider = new LlmAdDetectionProvider({ apiKey: 'key' })
      expect(provider.baseUrl).to.equal('https://api.deepseek.com/v1')
      expect(provider.model).to.equal('deepseek-chat')
    })

    it('accepts any OpenAI-compatible base url and strips trailing slashes', () => {
      const provider = new LlmAdDetectionProvider({ apiKey: 'key', baseUrl: 'https://api.openai.com/v1///', model: 'gpt-4o-mini' })
      expect(provider.baseUrl).to.equal('https://api.openai.com/v1')
      expect(provider.model).to.equal('gpt-4o-mini')
    })
  })

  describe('validate', () => {
    it('requires an api key for a remote provider', async () => {
      const provider = new LlmAdDetectionProvider({})
      let threw = false
      await provider.validate().catch(() => (threw = true))
      expect(threw).to.be.true
    })

    it('allows a local provider without a key', async () => {
      const provider = new LlmAdDetectionProvider({ baseUrl: 'http://localhost:11434/v1' })
      await provider.validate()
    })
  })

  describe('parseResponse', () => {
    const provider = new LlmAdDetectionProvider({ apiKey: 'key' })

    it('parses a plain json object', () => {
      expect(provider.parseResponse('{"segments":[{"start":1,"end":9}]}')).to.have.lengthOf(1)
    })

    it('parses a bare array', () => {
      expect(provider.parseResponse('[{"start":1,"end":9}]')).to.have.lengthOf(1)
    })

    it('strips markdown fences', () => {
      expect(provider.parseResponse('```json\n{"segments":[{"start":1,"end":9}]}\n```')).to.have.lengthOf(1)
    })

    it('recovers json embedded in prose', () => {
      expect(provider.parseResponse('Sure! {"segments":[{"start":1,"end":9}]} Hope that helps')).to.have.lengthOf(1)
    })

    it('returns null for unparseable content', () => {
      expect(provider.parseResponse('no json here')).to.be.null
      expect(provider.parseResponse('')).to.be.null
      expect(provider.parseResponse('{"segments": not json}')).to.be.null
    })
  })

  describe('buildWindows', () => {
    const provider = new LlmAdDetectionProvider({ apiKey: 'key' })

    it('returns no windows for an empty transcript', () => {
      expect(provider.buildWindows([])).to.be.empty
    })

    it('fits a short transcript into a single window', () => {
      expect(provider.buildWindows(buildSegments(10))).to.have.lengthOf(1)
    })

    it('produces overlapping windows for a long transcript', () => {
      const windows = provider.buildWindows(buildSegments(200))
      expect(windows.length).to.be.greaterThan(1)
      // Consecutive windows must share content so a boundary-straddling ad
      // is seen whole by at least one call
      const firstEnd = windows[0][windows[0].length - 1].end
      const secondStart = windows[1][0].start
      expect(secondStart).to.be.lessThan(firstEnd)
    })
  })

  describe('detect', () => {
    afterEach(() => sinon.restore())

    it('collects segments across windows', async () => {
      const provider = new LlmAdDetectionProvider({ apiKey: 'key' })
      sinon.stub(axios, 'post').resolves({
        data: { choices: [{ message: { content: '{"segments":[{"start":10,"end":40,"confidence":0.9,"label":"preroll"}]}' } }] }
      })

      const result = await provider.detect({ segments: buildSegments(20) }, {})
      expect(result).to.have.lengthOf(1)
      expect(result[0]).to.include({ start: 10, end: 40, confidence: 0.9 })
    })

    it('rejects timestamps outside the window the model was shown', async () => {
      const provider = new LlmAdDetectionProvider({ apiKey: 'key' })
      sinon.stub(axios, 'post').resolves({
        data: { choices: [{ message: { content: '{"segments":[{"start":99999,"end":100050,"confidence":0.9}]}' } }] }
      })

      const result = await provider.detect({ segments: buildSegments(20) }, {})
      expect(result).to.be.empty
    })

    it('retries once on malformed json', async () => {
      const provider = new LlmAdDetectionProvider({ apiKey: 'key' })
      const post = sinon.stub(axios, 'post')
      post.onFirstCall().resolves({ data: { choices: [{ message: { content: 'sorry, no json' } }] } })
      post.onSecondCall().resolves({ data: { choices: [{ message: { content: '{"segments":[{"start":10,"end":40}]}' } }] } })

      const result = await provider.detect({ segments: buildSegments(20) }, {})
      expect(post.callCount).to.equal(2)
      expect(result).to.have.lengthOf(1)
    })

    it('does not lose the episode when one window fails', async () => {
      const provider = new LlmAdDetectionProvider({ apiKey: 'key' })
      sinon.stub(axios, 'post').rejects(new Error('502 bad gateway'))

      const result = await provider.detect({ segments: buildSegments(20) }, {})
      expect(result).to.be.empty
    })

    it('returns nothing for an empty transcript without calling the api', async () => {
      const provider = new LlmAdDetectionProvider({ apiKey: 'key' })
      const post = sinon.stub(axios, 'post')
      const result = await provider.detect({ segments: [] }, {})
      expect(result).to.be.empty
      expect(post.called).to.be.false
    })
  })
})
