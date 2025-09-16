// api/rss-app.mjs
import { request } from 'undici'

const DOMAINS = [
  't.co',
  'bit.ly',
  'tinyurl.com',
  'goo.gl',
  'ow.ly',
  'buff.ly',
  'rebrand.ly',
  'is.gd',
  'soo.gd',
  's.id',
  'cutt.ly'
]

export default async function handler(req, res) {
  let text = ''
  try {
    const body = await getBody(req)
    text = body?.text || ''
  } catch {
    res.status(400).json({ error: 'Invalid JSON body' })
    return
  }

  // Match all shortener links
  const domainsGroup = DOMAINS.map(d => d.replace(/\./g, '\\.')).join('|')
  const occurences = Array.from(
    text.matchAll(new RegExp(`https?://(?:${domainsGroup})/[\\w\\d-_]+`, 'gi'))
  )

  const uniqueLinks = [...new Set(occurences.map(([link]) => link))]

  // Resolve all in parallel
  const results = await Promise.all(
    uniqueLinks.map(async link => {
      try {
        const {
          headers: { location }
        } = await request(link, { method: 'HEAD' })
        return [link, typeof location === 'string' ? location : link]
      } catch {
        return [link, link]
      }
    })
  )

  for (const [short, resolved] of results) {
    text = text.replaceAll(short, resolved)
  }

  res.status(200).json({ text })
}

// Helper: parse body from Node's req stream
async function getBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => (data += chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}
