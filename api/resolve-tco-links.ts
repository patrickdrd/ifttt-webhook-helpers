import type { VercelApiHandler } from '@vercel/node'
import { request } from 'undici'

// Known shorteners list
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
  'cutt.ly',
  'shorte.st',
  'adf.ly',
  'lnkd.in',
  'trib.al',
  'bl.ink',
  'po.st',
  'mcaf.ee'
]

const handler: VercelApiHandler = async (req, res) => {
  let { text = '' } = req.body as { text: string }

  // Build a regex that matches all known shortener links
  const domainsGroup = DOMAINS.map(d => d.replace(/\./g, '\\.')).join('|')
  const occurences = text.matchAll(
    new RegExp(`https?://(?:${domainsGroup})/[\\w\\d-_]+`, 'gi')
  )

  const toReplace = new Map<string, string>()
  for (const [link] of occurences) {
    if (toReplace.has(link)) continue

    try {
      // eslint-disable-next-line no-await-in-loop
      const {
        headers: { location }
      } = await request(link, { method: 'HEAD' })

      if (typeof location === 'string') {
        toReplace.set(link, location)
      } else {
        toReplace.set(link, link)
      }
    } catch {
      toReplace.set(link, link)
    }
  }

  for (const [link, resolvedUrl] of toReplace) {
    text = text.replaceAll(link, resolvedUrl)
  }

  res.status(200).json({ text })
}

export default handler
