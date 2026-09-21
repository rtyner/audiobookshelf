<template>
  <div>
    <app-settings-content :header-text="$strings.HeaderAdDetection" :description="$strings.LabelAdDetectionEnabledHelp">
      <form @submit.prevent="submitForm">
        <!-- master toggle -->
        <div class="flex items-center py-3">
          <ui-toggle-switch labeledBy="ad-detection-enabled" v-model="newSettings.adDetectionEnabled" :disabled="saving" />
          <div class="pl-4">
            <span id="ad-detection-enabled">{{ $strings.LabelAdDetectionEnabled }}</span>
          </div>
        </div>

        <div :class="newSettings.adDetectionEnabled ? '' : 'opacity-50 pointer-events-none'">
          <div class="flex items-center py-2">
            <ui-toggle-switch labeledBy="ad-detection-auto-run" v-model="newSettings.adDetectionAutoRun" :disabled="saving" />
            <div class="pl-4">
              <span id="ad-detection-auto-run">{{ $strings.LabelAdDetectionAutoRun }}</span>
            </div>
          </div>

          <div class="flex items-center py-2">
            <ui-toggle-switch labeledBy="ad-detection-auto-skip" v-model="newSettings.adDetectionAutoSkip" :disabled="saving" />
            <div class="pl-4">
              <span id="ad-detection-auto-skip">{{ $strings.LabelAdDetectionAutoSkip }}</span>
            </div>
          </div>

          <div class="flex items-center -mx-1 my-4">
            <div class="w-full md:w-1/3 px-1">
              <ui-text-input-with-label v-model="newSettings.adDetectionMinConfidence" type="number" step="0.05" min="0" max="0.95" :disabled="saving" :label="$strings.LabelAdDetectionMinConfidence" />
            </div>
          </div>

          <p class="uppercase text-xs font-semibold text-gray-300 mt-6 mb-2">{{ $strings.LabelAdDetectionTranscriptionProvider }}</p>
          <div class="flex items-center -mx-1 mb-2">
            <div class="w-full md:w-1/2 px-1">
              <ui-dropdown v-model="newSettings.adDetectionTranscriptionProvider" :items="transcriptionProviderItems" :disabled="saving" :label="$strings.LabelAdDetectionTranscriptionProvider" />
            </div>
            <div v-if="newSettings.adDetectionTranscriptionProvider === 'whisper-local'" class="w-full md:w-1/2 px-1">
              <ui-dropdown v-model="newSettings.adDetectionWhisperModel" :items="whisperModelItems" :disabled="saving" :label="$strings.LabelAdDetectionWhisperModel" />
            </div>
          </div>
          <div v-if="newSettings.adDetectionTranscriptionProvider !== 'whisper-local'" class="flex items-center -mx-1 mb-2">
            <div class="w-full md:w-1/2 px-1">
              <ui-text-input-with-label v-model="newSettings.adDetectionTranscriptionBaseUrl" :disabled="saving" :label="$strings.LabelAdDetectionLlmBaseUrl" />
            </div>
            <div class="w-full md:w-1/4 px-1">
              <ui-text-input-with-label v-model="newSettings.adDetectionTranscriptionModel" :disabled="saving" :label="$strings.LabelAdDetectionLlmModel" />
            </div>
            <div class="w-full md:w-1/4 px-1">
              <ui-text-input-with-label v-model="newSettings.adDetectionTranscriptionApiKey" type="password" :placeholder="transcriptionKeyPlaceholder" :disabled="saving" :label="$strings.LabelAdDetectionLlmApiKey" />
            </div>
          </div>

          <p class="uppercase text-xs font-semibold text-gray-300 mt-6 mb-2">{{ $strings.LabelAdDetectionLlmProvider }}</p>
          <div class="flex items-center -mx-1 mb-2">
            <div class="w-full md:w-1/3 px-1">
              <ui-dropdown v-model="newSettings.adDetectionLlmProvider" :items="llmProviderItems" :disabled="saving" :label="$strings.LabelAdDetectionLlmProvider" />
            </div>
            <div v-if="newSettings.adDetectionLlmProvider === 'llm'" class="w-full md:w-1/3 px-1">
              <ui-text-input-with-label v-model="newSettings.adDetectionLlmBaseUrl" :disabled="saving" :label="$strings.LabelAdDetectionLlmBaseUrl" />
            </div>
            <div v-if="newSettings.adDetectionLlmProvider === 'llm'" class="w-full md:w-1/3 px-1">
              <ui-text-input-with-label v-model="newSettings.adDetectionLlmModel" :disabled="saving" :label="$strings.LabelAdDetectionLlmModel" />
            </div>
          </div>
          <div v-if="newSettings.adDetectionLlmProvider === 'llm'" class="flex items-center -mx-1 mb-2">
            <div class="w-full md:w-1/2 px-1">
              <ui-text-input-with-label v-model="newSettings.adDetectionLlmApiKey" type="password" :placeholder="llmKeyPlaceholder" :disabled="saving" :label="$strings.LabelAdDetectionLlmApiKey" />
            </div>
          </div>
        </div>

        <div class="flex justify-end pt-4">
          <ui-btn type="submit" :disabled="saving">{{ $strings.ButtonSave }}</ui-btn>
        </div>
      </form>
    </app-settings-content>
  </div>
</template>

<script>
export default {
  asyncData({ store, redirect }) {
    if (!store.getters['user/getIsAdminOrUp']) {
      redirect('/')
    }
  },
  data() {
    return {
      saving: false,
      newSettings: {}
    }
  },
  computed: {
    serverSettings() {
      return this.$store.state.serverSettings
    },
    transcriptionProviderItems() {
      return [
        { value: 'whisper-local', text: 'whisper.cpp (local)' },
        { value: 'openai-compatible', text: 'OpenAI-compatible API' }
      ]
    },
    llmProviderItems() {
      return [
        { value: 'llm', text: 'OpenAI-compatible API (DeepSeek, OpenAI, Ollama, ...)' },
        { value: 'none', text: 'Keyword heuristic (no AI)' }
      ]
    },
    whisperModelItems() {
      return ['tiny.en', 'base.en', 'small.en', 'medium.en', 'large-v3-turbo'].map((model) => ({ value: model, text: model }))
    },
    llmKeyPlaceholder() {
      return this.serverSettings?.adDetectionLlmApiKeySet ? '••••••••' : ''
    },
    transcriptionKeyPlaceholder() {
      return this.serverSettings?.adDetectionTranscriptionApiKeySet ? '••••••••' : ''
    }
  },
  methods: {
    initSettings() {
      const settings = this.serverSettings || {}
      this.newSettings = {
        adDetectionEnabled: !!settings.adDetectionEnabled,
        adDetectionAutoRun: settings.adDetectionAutoRun !== false,
        adDetectionAutoSkip: settings.adDetectionAutoSkip !== false,
        adDetectionMinConfidence: settings.adDetectionMinConfidence ?? 0.7,
        adDetectionTranscriptionProvider: settings.adDetectionTranscriptionProvider || 'whisper-local',
        adDetectionWhisperModel: settings.adDetectionWhisperModel || 'base.en',
        adDetectionTranscriptionBaseUrl: settings.adDetectionTranscriptionBaseUrl || '',
        adDetectionTranscriptionModel: settings.adDetectionTranscriptionModel || '',
        // Keys are never sent to the browser - an empty field means "unchanged"
        adDetectionTranscriptionApiKey: '',
        adDetectionLlmProvider: settings.adDetectionLlmProvider || 'llm',
        adDetectionLlmBaseUrl: settings.adDetectionLlmBaseUrl || 'https://api.deepseek.com/v1',
        adDetectionLlmModel: settings.adDetectionLlmModel || 'deepseek-chat',
        adDetectionLlmApiKey: ''
      }
    },
    submitForm() {
      const payload = { ...this.newSettings }
      payload.adDetectionMinConfidence = Number(payload.adDetectionMinConfidence)
      if (isNaN(payload.adDetectionMinConfidence)) payload.adDetectionMinConfidence = 0.7

      // Omit blank key fields so saving the form does not wipe a stored key
      if (!payload.adDetectionLlmApiKey) delete payload.adDetectionLlmApiKey
      if (!payload.adDetectionTranscriptionApiKey) delete payload.adDetectionTranscriptionApiKey

      this.saving = true
      this.$store
        .dispatch('updateServerSettings', payload)
        .then((response) => {
          this.saving = false
          if (response.error) {
            this.$toast.error(response.error)
            this.initSettings()
            return
          }
          this.$toast.success(this.$strings.ToastServerSettingsUpdateSuccess)
          this.initSettings()
        })
        .catch((error) => {
          this.saving = false
          console.error('Failed to update ad detection settings', error)
          this.$toast.error(this.$strings.ToastFailedToUpdate)
        })
    }
  },
  mounted() {
    this.initSettings()
  }
}
</script>
