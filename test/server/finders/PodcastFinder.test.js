const { expect } = require('chai')
const sinon = require('sinon')
const axios = require('axios')

const PodcastFinder = require('../../../server/finders/PodcastFinder')

describe('PodcastFinder', () => {
  afterEach(() => sinon.restore())

  it('returns mapped results on success', async () => {
    sinon.stub(axios, 'get').resolves({
      data: { resultCount: 1, results: [{ collectionName: 'Countdown To Classic', artistName: 'Joshua Corbett', feedUrl: 'https://example.com/feed', collectionId: 1 }] }
    })
    const results = await PodcastFinder.search('countdown to classic', { country: 'us' })
    expect(results).to.have.lengthOf(1)
    expect(results[0].title).to.equal('Countdown To Classic')
  })

  it('propagates a provider failure instead of reporting no matches', async () => {
    // Apple throttles aggressively. Swallowing this made a throttled lookup
    // indistinguishable from a podcast that does not exist.
    const err = new Error('socket hang up')
    err.code = 'ETIMEDOUT'
    sinon.stub(axios, 'get').rejects(err)

    let caught = null
    await PodcastFinder.search('countdown to classic', { country: 'us' }).catch((e) => (caught = e))
    expect(caught).to.not.be.null
    expect(caught.isProviderError).to.be.true
    expect(caught.message).to.include('ETIMEDOUT')
  })

  it('returns null without a search term', async () => {
    expect(await PodcastFinder.search('')).to.be.null
  })

  it('keeps cover lookup best-effort when the provider fails', async () => {
    sinon.stub(axios, 'get').rejects(new Error('boom'))
    expect(await PodcastFinder.findCovers('anything')).to.deep.equal([])
  })
})
