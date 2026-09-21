const { expect } = require('chai')
const sinon = require('sinon')
const axios = require('axios')
const os = require('os')
const Path = require('path')
const fs = require('fs')

const OpenAICompatibleTranscriptionProvider = require('../../../server/providers/transcription/OpenAICompatibleTranscriptionProvider')

describe('OpenAICompatibleTranscriptionProvider', () => {
  let wavPath

  before(() => {
    // A real file on disk - the provider streams it, so a stub would not
    // exercise the file handling that matters here.
    wavPath = Path.join(os.tmpdir(), `abs-transcribe-test-${Date.now()}.wav`)
    fs.writeFileSync(wavPath, Buffer.alloc(2048))
  })

  after(() => {
    fs.rmSync(wavPath, { force: true })
  })

  afterEach(() => sinon.restore())

  describe('defaults', () => {
    it('defaults to the OpenAI endpoint and strips trailing slashes', () => {
      const provider = new OpenAICompatibleTranscriptionProvider({ apiKey: 'k', baseUrl: 'http://whisper:8000/v1//' })
      expect(provider.baseUrl).to.equal('http://whisper:8000/v1')
    })
  })

  describe('validate', () => {
    it('requires an api key', async () => {
      let threw = false
      await new OpenAICompatibleTranscriptionProvider({}).validate().catch(() => (threw = true))
      expect(threw).to.be.true
    })
  })

  describe('transcribe', () => {
    it('posts the audio file and maps the segments', async () => {
      const post = sinon.stub(axios, 'post').resolves({
        data: {
          language: 'en',
          duration: 76.1,
          segments: [
            { start: 0, end: 4.8, text: ' Hello and welcome ' },
            { start: 32.4, end: 38, text: ' This episode is brought to you by acme ' }
          ]
        }
      })

      const provider = new OpenAICompatibleTranscriptionProvider({ apiKey: 'k', baseUrl: 'http://whisper:8000/v1', model: 'Systran/faster-whisper-small' })
      const transcript = await provider.transcribe(wavPath)

      expect(post.calledOnce).to.be.true
      const [url, form, config] = post.firstCall.args
      expect(url).to.equal('http://whisper:8000/v1/audio/transcriptions')
      expect(config.headers.Authorization).to.equal('Bearer k')
      // axios 0.27 cannot serialize a native FormData, so the body must be a
      // form-data instance carrying its own multipart headers
      expect(config.headers['content-type']).to.match(/^multipart\/form-data; boundary=/)

      // Regression: the file must actually be opened and attached. Serialising
      // the form exercises the read, so a bad file handle fails here.
      const body = await new Promise((resolve, reject) => {
        form.pipe(
          require('stream').Writable({
            write(chunk, _enc, cb) {
              this._data = (this._data || '') + chunk.toString('binary')
              cb()
            },
            final(cb) {
              resolve(this._data)
              cb()
            }
          })
        )
        form.on('error', reject)
      })
      expect(body).to.include(`filename="${Path.basename(wavPath)}"`)
      expect(body).to.include('Systran/faster-whisper-small')
      expect(body).to.include('verbose_json')

      expect(transcript.segments).to.have.lengthOf(2)
      expect(transcript.segments[1]).to.include({ start: 32.4, end: 38 })
      expect(transcript.segments[1].text).to.equal('This episode is brought to you by acme')
      expect(transcript.duration).to.equal(76.1)
      expect(transcript.language).to.equal('en')
    })

    it('rejects a response with text but no timestamps', async () => {
      sinon.stub(axios, 'post').resolves({ data: { text: 'a whole transcript with no timings' } })
      const provider = new OpenAICompatibleTranscriptionProvider({ apiKey: 'k' })

      let message = null
      await provider.transcribe(wavPath).catch((e) => (message = e.message))
      expect(message).to.include('timestamps')
    })

    it('drops malformed segments', async () => {
      sinon.stub(axios, 'post').resolves({
        data: { segments: [{ start: 0, end: 5, text: 'keep' }, { start: 'x', end: 5, text: 'drop' }, { start: 10, end: 15, text: '   ' }] }
      })
      const provider = new OpenAICompatibleTranscriptionProvider({ apiKey: 'k' })
      const transcript = await provider.transcribe(wavPath)
      expect(transcript.segments).to.have.lengthOf(1)
      expect(transcript.segments[0].text).to.equal('keep')
    })
  })
})
