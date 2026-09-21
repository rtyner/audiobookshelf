const Logger = require('../Logger')
const iTunes = require('../providers/iTunes')

class PodcastFinder {
  constructor() {
    this.iTunesApi = new iTunes()
  }

  /**
   *
   * @param {string} term
   * @param {{country:string}} options
   * @returns {Promise<import('../providers/iTunes').iTunesPodcastSearchResult[]>}
   */
  async search(term, options = {}) {
    if (!term) return null
    Logger.debug(`[iTunes] Searching for podcast with term "${term}"`)
    const results = await this.iTunesApi.searchPodcasts(term, options)
    Logger.debug(`[iTunes] Podcast search for "${term}" returned ${results.length} results`)
    return results
  }

  /**
   * @param {string} term
   * @returns {Promise<string[]>}
   */
  async findCovers(term) {
    if (!term) return null
    Logger.debug(`[iTunes] Searching for podcast covers with term "${term}"`)
    // Cover lookup is best-effort - a provider outage must not fail the caller
    const results = await this.iTunesApi.searchPodcasts(term).catch((error) => {
      Logger.warn(`[iTunes] Cover search failed for "${term}": ${error.message}`)
      return []
    })
    if (!results) return []
    return results.map((r) => r.cover).filter((r) => r)
  }
}
module.exports = new PodcastFinder()
