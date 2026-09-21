<template>
  <div>
    <div class="flex items-center mb-2">
      <p class="font-semibold text-xs grow">{{ $strings.HeaderAdSegments }}</p>
      <p v-if="statusText" class="text-xs text-gray-300 px-2">{{ statusText }}</p>
      <ui-btn v-if="userIsAdminOrUp" :disabled="processing || !adDetectionEnabled" small @click="runDetection">{{ $strings.ButtonDetectAds }}</ui-btn>
    </div>

    <p v-if="error" class="text-xs text-error mb-2">{{ error }}</p>

    <table v-if="segments.length" class="text-xs w-full">
      <tr class="text-left text-gray-300">
        <th class="font-normal py-1">{{ $strings.LabelStartTime }}</th>
        <th class="font-normal py-1">{{ $strings.LabelEndTime }}</th>
        <th class="font-normal py-1">{{ $strings.LabelAdSegmentConfidence }}</th>
        <th class="font-normal py-1">{{ $strings.LabelType }}</th>
        <th class="font-normal py-1 w-20"></th>
      </tr>
      <tr v-for="segment in segments" :key="segment.id" class="border-t border-white/5" :class="segment.enabled ? '' : 'opacity-50'">
        <td class="py-1 font-mono">{{ $secondsToTimestamp(segment.startTime) }}</td>
        <td class="py-1 font-mono">{{ $secondsToTimestamp(segment.endTime) }}</td>
        <td class="py-1">{{ Math.round(segment.confidence * 100) }}%</td>
        <td class="py-1">{{ segment.source === 'user' ? $strings.LabelAdSegmentSourceUser : $strings.LabelAdSegmentSourceAi }}</td>
        <td class="py-1 text-right">
          <button v-if="userCanUpdate" class="material-symbols text-base align-middle" :aria-label="$strings.ButtonSave" @click="toggleEnabled(segment)">
            {{ segment.enabled ? 'visibility' : 'visibility_off' }}
          </button>
          <button v-if="userCanDelete" class="material-symbols text-base align-middle text-error pl-2" :aria-label="$strings.ButtonDelete" @click="deleteSegment(segment)">delete</button>
        </td>
      </tr>
    </table>
    <p v-else-if="!processing" class="text-xs text-gray-300">{{ $strings.MessageNoAdSegments }}</p>
  </div>
</template>

<script>
export default {
  props: {
    libraryItemId: String,
    episodeId: String
  },
  data() {
    return {
      processing: false,
      segments: [],
      status: null,
      error: null
    }
  },
  computed: {
    adDetectionEnabled() {
      return this.$store.getters['getServerSetting']('adDetectionEnabled') === true
    },
    userIsAdminOrUp() {
      return this.$store.getters['user/getIsAdminOrUp']
    },
    userCanUpdate() {
      return this.$store.getters['user/getUserCanUpdate']
    },
    userCanDelete() {
      return this.$store.getters['user/getUserCanDelete']
    },
    statusText() {
      if (!this.status || this.status === 'complete') return ''
      return this.status
    }
  },
  watch: {
    episodeId: {
      immediate: true,
      handler() {
        this.loadSegments()
      }
    }
  },
  methods: {
    endpoint(suffix = '') {
      return `/api/podcasts/${this.libraryItemId}/episode/${this.episodeId}/ad-segments${suffix}`
    },
    async loadSegments() {
      if (!this.libraryItemId || !this.episodeId) return
      this.processing = true
      try {
        const data = await this.$axios.$get(this.endpoint())
        this.segments = data.segments || []
        this.status = data.status
        this.error = data.error
      } catch (error) {
        console.error('Failed to load ad segments', error)
        this.segments = []
      }
      this.processing = false
    },
    async runDetection() {
      this.processing = true
      try {
        await this.$axios.$post(this.endpoint('?force=1'), {})
        this.$toast.success(this.$strings.MessageAdDetectionQueued)
        this.status = 'queued'
      } catch (error) {
        this.$toast.error(error.response?.data || this.$strings.ToastFailedToUpdate)
      }
      this.processing = false
    },
    async toggleEnabled(segment) {
      try {
        const updated = await this.$axios.$patch(`${this.endpoint()}/${segment.id}`, { enabled: !segment.enabled })
        Object.assign(segment, updated)
      } catch (error) {
        this.$toast.error(this.$strings.ToastFailedToUpdate)
      }
    },
    async deleteSegment(segment) {
      try {
        await this.$axios.$delete(`${this.endpoint()}/${segment.id}`)
        this.segments = this.segments.filter((s) => s.id !== segment.id)
      } catch (error) {
        this.$toast.error(this.$strings.ToastFailedToUpdate)
      }
    },
    segmentsUpdated(payload) {
      if (payload?.episodeId !== this.episodeId) return
      this.segments = payload.segments || []
      if (payload.status) this.status = payload.status
      this.error = payload.error || null
    }
  },
  mounted() {
    this.$eventBus.$on('ad-segments-updated', this.segmentsUpdated)
  },
  beforeDestroy() {
    this.$eventBus.$off('ad-segments-updated', this.segmentsUpdated)
  }
}
</script>
