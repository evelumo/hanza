import { describe, expect, it } from 'vitest'
import { createRecordingFetch } from './record'

describe('createRecordingFetch', () => {
  it('keeps the order requests were sent in, even when an earlier one answers later', async () => {
    const transport: typeof fetch = async (input) => {
      const url = new URL(new Request(input).url)
      if (url.pathname === '/slow') await new Promise((resolve) => setTimeout(resolve, 20))
      return Response.json({ path: url.pathname })
    }
    const recorder = createRecordingFetch({ fetch: transport })
    await Promise.all([recorder.fetch('https://api.example.test/slow'), recorder.fetch('https://api.example.test/fast')])
    expect(recorder.cassette().interactions.map((interaction) => interaction.request.url)).toEqual([
      'https://api.example.test/slow',
      'https://api.example.test/fast',
    ])
  })

  it('records nothing for a request that failed at the network level', async () => {
    const recorder = createRecordingFetch({ fetch: () => Promise.reject(new TypeError('fetch failed')) })
    await expect(recorder.fetch('https://api.example.test/x')).rejects.toThrow('fetch failed')
    expect(recorder.size).toBe(0)
    expect(recorder.cassette().interactions).toEqual([])
  })
})
