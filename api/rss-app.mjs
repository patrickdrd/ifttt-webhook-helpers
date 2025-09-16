import type { VercelApiHandler } from '@vercel/node'
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

const handler: VercelApiHandler = async (req, res) => {
  let { text = '' } = req.body as { text: string }

  // 1. Match all shortener links
  const domainsGroup = DOMAINS.map(d => d.replace(/\./g, '\\.')).join('|')
  const occurences = Array.from(
    text.matchAll(new RegExp(`https?://(?:${domainsGroup})/[\\w\\d-_]+`, 'gi'))
  )

  // 2. Deduplicate
  const uniqueLinks = [...new Set(occurences.map(([link]) => link))]

  // 3. Resolve all links in parallel
  const results = await Promise.all(
    uniqueLinks.map(async link => {
      try {
        const {
          headers: { location }
        } = await request(link, { method: 'HEAD' })
        return [link, typeof location === 'string' ? location : link] as const
      } catch {
        return [link, link] as const
      }
    })
  )

  // 4. Replace all in text
  for (const [short, resolved] of results) {
    text = text.replaceAll(short, resolved)
  }

  // 5. Return
  res.status(200).json({ text })
}

export default handler
