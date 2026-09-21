const { expect } = require('chai')
const { Sequelize } = require('sequelize')

const migration = require('../../../server/migrations/v2.37.0-add-ad-segments')

describe('v2.37.0-add-ad-segments migration', () => {
  let sequelize
  let queryInterface
  const logger = { info: () => {}, warn: () => {}, error: () => {} }

  beforeEach(() => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    queryInterface = sequelize.getQueryInterface()
  })

  afterEach(async () => {
    await sequelize.close()
  })

  it('creates the table and its indexes', async () => {
    await migration.up({ context: { queryInterface, logger } })

    const tables = await queryInterface.showAllTables()
    expect(tables).to.include('mediaItemAdSegments')

    const columns = await queryInterface.describeTable('mediaItemAdSegments')
    expect(Object.keys(columns)).to.include.members(['id', 'mediaItemId', 'mediaItemType', 'startTime', 'endTime', 'confidence', 'label', 'source', 'enabled', 'createdAt', 'updatedAt'])

    const indexes = await queryInterface.showIndex('mediaItemAdSegments')
    const names = indexes.map((index) => index.name)
    expect(names).to.include('media_item_ad_segments_media_item')
    expect(names).to.include('media_item_ad_segments_start_time')
  })

  it('is idempotent', async () => {
    await migration.up({ context: { queryInterface, logger } })
    await migration.up({ context: { queryInterface, logger } })
    const tables = await queryInterface.showAllTables()
    expect(tables.filter((t) => t === 'mediaItemAdSegments')).to.have.lengthOf(1)
  })

  it('drops the table on downgrade', async () => {
    await migration.up({ context: { queryInterface, logger } })
    await migration.down({ context: { queryInterface, logger } })
    const tables = await queryInterface.showAllTables()
    expect(tables).to.not.include('mediaItemAdSegments')
  })

  it('downgrade is safe when the table is already gone', async () => {
    await migration.down({ context: { queryInterface, logger } })
  })
})
