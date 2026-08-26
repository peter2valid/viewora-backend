type CreatePropertyBody = {
  title: string
  space_type: string
  description?: string | null
  location_text?: string
  price_kes?: number
  bedrooms?: number
  bathrooms?: number
  area_sqm?: number
  vehicle_year?: number
  vehicle_mileage_km?: number
  vehicle_transmission?: string
  vehicle_fuel_type?: string
  amenities?: string[]
  slug?: string | null
  client_generated_id?: string
  created_via?: 'web' | 'telegram' | 'whatsapp'
}

type SignedUrlRequest = {
  propertyId: string
  mediaType: string
  fileName: string
  contentType: string
  fileSize?: number
}

type CompleteUploadRequest = {
  propertyId: string
  mediaType: string
  objectKey: string
  publicUrl: string
  width?: number
  height?: number
  fileSize?: number
  client_event_id?: string
}

type PublishResponse = {
  id: string
  slug: string | null
  is_published: boolean
}

type CreateSceneBody = {
  name: string
  raw_image_url: string
}

// Distinguishes "the backend rejected this for a real, expected reason"
// (quota limits, inactive subscription — the error envelope's `code`/`message`
// are meant to be shown to someone) from a genuine bug, so callers can choose
// a friendly reply instead of falling through to a generic failure message.
export class ApiError extends Error {
  constructor(public status: number, public code: string | undefined, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export function createClient(baseUrl: string, getAuthHeader: () => string | null) {
  async function call(path: string, body: unknown, method = 'POST') {
    const url = `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`
    const auth = getAuthHeader()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (auth) headers.Authorization = auth
    const res = await fetch(url, { method, headers, body: JSON.stringify(body) })
    const text = await res.text()
    let json: any
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    if (!res.ok) {
      const message = typeof json?.message === 'string' ? json.message : `HTTP ${res.status} ${res.statusText}`
      throw new ApiError(res.status, typeof json?.code === 'string' ? json.code : undefined, message)
    }
    // Every successful response gets wrapped by index.ts's global onSend
    // hook into { success: true, data: <actual payload>, meta }. Unwrap it
    // so callers see the resource itself (id, slug, ...), not the envelope —
    // this is the same shape frontend code gets automatically via
    // useApiFetch's onResponse handler; this client needs to do it manually.
    if (json && typeof json === 'object' && json.success === true && 'data' in json) {
      return json.data
    }
    return json
  }

  return {
    async createProperty(body: CreatePropertyBody) {
      return call('/spaces', body)
    },
    async createSignedUrl(body: SignedUrlRequest) {
      return call('/uploads/create-signed-url', body)
    },
    async completeUpload(body: CompleteUploadRequest) {
      return call('/uploads/complete', body)
    },
    async publishProperty(propertyId: string, publish: boolean): Promise<PublishResponse> {
      return call(`/spaces/${propertyId}/publish`, { publish })
    },
    // Uploading a panorama to property_media (completeUpload) is NOT enough
    // on its own — the viewer renders from the *scenes* table, and only this
    // call creates a scene row and enqueues the actual tile-generation job
    // ('tile-scene' — a different queue job than the one completeUpload
    // schedules, which only does housekeeping like EXIF stripping). Skipping
    // this is exactly why a property can show as "published" (property_media
    // satisfies that check) while the tour page still says no renderable
    // scenes exist.
    async createScene(propertyId: string, body: CreateSceneBody) {
      return call(`/spaces/${propertyId}/scenes`, body)
    },
  }
}

// A static INTERNAL_API_KEY never actually worked here — /spaces and
// /uploads/* require a real Supabase-verified user token (fastify.authenticate),
// not an arbitrary internal secret. Each conversation session has its own real
// Supabase user (see conversation/anonymousAuth.ts); use that session's
// access token so calls are authenticated exactly like any other user's.
export function createClientForSession(accessToken: string) {
  const baseUrl = process.env.INTERNAL_API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`
  return createClient(baseUrl, () => `Bearer ${accessToken}`)
}
