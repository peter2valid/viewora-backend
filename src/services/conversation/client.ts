type CreatePropertyBody = {
  title: string
  space_type: string
  description?: string | null
  slug?: string | null
  client_generated_id?: string
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
      throw new Error(`HTTP ${res.status} ${res.statusText} - ${JSON.stringify(json)}`)
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
