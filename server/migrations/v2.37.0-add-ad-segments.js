/**
 * @typedef MigrationContext
 * @property {import('sequelize').QueryInterface} queryInterface
 * @property {import('../Logger')} logger
 *
 * @typedef MigrationOptions
 * @property {MigrationContext} context
 */

const { DataTypes } = require('sequelize')

const migrationVersion = '2.37.0'
const migrationName = `${migrationVersion}-add-ad-segments`
const loggerPrefix = `[${migrationVersion} migration]`

const tableName = 'mediaItemAdSegments'

const indexes = [
  {
    name: 'media_item_ad_segments_media_item',
    fields: ['mediaItemId', 'mediaItemType']
  },
  {
    name: 'media_item_ad_segments_start_time',
    fields: ['mediaItemId', 'startTime']
  }
]

/**
 * Creates the mediaItemAdSegments table used by AI ad detection.
 *
 * @param {MigrationOptions} options
 */
async function up({ context: { queryInterface, logger } }) {
  logger.info(`${loggerPrefix} UPGRADE BEGIN: ${migrationName}`)

  const tables = await queryInterface.showAllTables()
  if (tables.includes(tableName)) {
    logger.info(`${loggerPrefix} table "${tableName}" already exists`)
  } else {
    logger.info(`${loggerPrefix} creating table "${tableName}"`)
    await queryInterface.createTable(tableName, {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      mediaItemId: {
        type: DataTypes.UUID,
        allowNull: false
      },
      mediaItemType: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'podcastEpisode'
      },
      startTime: {
        type: DataTypes.FLOAT,
        allowNull: false
      },
      endTime: {
        type: DataTypes.FLOAT,
        allowNull: false
      },
      confidence: {
        type: DataTypes.FLOAT,
        defaultValue: 0
      },
      label: {
        type: DataTypes.STRING,
        defaultValue: 'unknown'
      },
      source: {
        type: DataTypes.STRING,
        defaultValue: 'ai'
      },
      enabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
      },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE
    })
  }

  for (const index of indexes) {
    await addIndexIfMissing(queryInterface, logger, index)
  }

  logger.info(`${loggerPrefix} UPGRADE END: ${migrationName}`)
}

/**
 * Drops the mediaItemAdSegments table.
 *
 * @param {MigrationOptions} options
 */
async function down({ context: { queryInterface, logger } }) {
  logger.info(`${loggerPrefix} DOWNGRADE BEGIN: ${migrationName}`)

  const tables = await queryInterface.showAllTables()
  if (tables.includes(tableName)) {
    logger.info(`${loggerPrefix} dropping table "${tableName}"`)
    await queryInterface.dropTable(tableName)
  } else {
    logger.info(`${loggerPrefix} table "${tableName}" does not exist`)
  }

  logger.info(`${loggerPrefix} DOWNGRADE END: ${migrationName}`)
}

async function addIndexIfMissing(queryInterface, logger, index) {
  const existing = await queryInterface.showIndex(tableName).catch(() => [])
  if (existing.some((i) => i.name === index.name)) {
    logger.info(`${loggerPrefix} index "${index.name}" already exists`)
    return
  }
  logger.info(`${loggerPrefix} adding index "${index.name}"`)
  await queryInterface.addIndex(tableName, { name: index.name, fields: index.fields })
}

module.exports = { up, down }
