const { expect } = require('chai')
const ServerSettings = require('../../../server/objects/settings/ServerSettings')

describe('ServerSettings ad detection', () => {
  it('clamps a confidence threshold that would reject every segment', () => {
    const settings = new ServerSettings({ adDetectionMinConfidence: 1 })
    expect(settings.adDetectionMinConfidence).to.equal(0.95)
  })

  it('clamps a negative threshold to zero', () => {
    expect(new ServerSettings({ adDetectionMinConfidence: -3 }).adDetectionMinConfidence).to.equal(0)
  })

  it('leaves a sensible threshold alone', () => {
    expect(new ServerSettings({ adDetectionMinConfidence: 0.7 }).adDetectionMinConfidence).to.equal(0.7)
  })

  it('defaults to 0.7', () => {
    expect(new ServerSettings({}).adDetectionMinConfidence).to.equal(0.7)
  })

  it('never returns provider api keys to the browser', () => {
    const settings = new ServerSettings({ adDetectionLlmApiKey: 'sk-secret', adDetectionTranscriptionApiKey: 'sk-other' })
    const json = settings.toJSONForBrowser()
    expect(json).to.not.have.property('adDetectionLlmApiKey')
    expect(json).to.not.have.property('adDetectionTranscriptionApiKey')
    expect(json.adDetectionLlmApiKeySet).to.be.true
    expect(json.adDetectionTranscriptionApiKeySet).to.be.true
  })
})
