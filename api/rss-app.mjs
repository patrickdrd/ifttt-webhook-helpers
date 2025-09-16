import type { VercelApiHandler } from '@vercel/node'
import { request } from 'undici'

const DOMAINS = [
  't.co', 'bit.ly', 'tinyurl.com', 'goo.gl', 'ow.ly', 'buff.ly',
  'rebrand.ly', 'is.gd', 'soo.gd', 's.id', 'cutt.ly'
]

const handler: VercelApiHandler = async (req, res) => {
  const { id } = req.query as { id: string }

  // 1. Fetch RSS feed
  const { body } = await request(`https://rss.app/feeds/${id}`)
  let text = await body.text()

  // 2. Expand shortlinks
  const domainsGroup = DOMAINS.map(d => d.replaceAll('.', '\\.')).join('|')
  const occurences = text.matchAll(new RegExp(`https?://(?:${domainsGroup})/\\w+`, 'g'))

  const toReplace = new Map<string, string>()
  for (const [link] of occurences) {
    if (toReplace.has(link)) continue
    try {
      // eslint-disable-next-line no-await-in-loop
      const { headers: { location } } = await request(link, { method: 'HEAD' })
      if (typeof location === 'string') toReplace.set(link, location)
      else toReplace.set(link, link)
    } catch {
      toReplace.set(link, link)
    }
  }

  for (const [link, resolvedUrl] of toReplace) {
    text = text.replaceAll(link, resolvedUrl)
  }

  // 3. Remove duplicate pic.twitter.com images
  try {
    // Extract all <enclosure> or <media:content> URLs
    const imageUrls = new Set<string>()
    const imgRegex = /<(?:enclosure|media:content)[^>]+url="([^"]+)"/g
    let match: RegExpExecArray | null
    while ((match = imgRegex.exec(text)) !== null) {
      imageUrls.add(match[1].split('?')[0])
    }

    // Remove <a href="https://pic.twitter.com/..."> links in <description> if duplicate
    text = text.replace(/<description><!\[CDATA\[(.*?)\]\]><\/description>/gs, (_, inner) => {
      let cleaned = inner
      const aRegex = /<a [^>]*href="https:\/\/pic\.twitter\.com\/[^"]+"[^>]*>(.*?)<\/a>/gs
      cleaned = cleaned.replace(aRegex, (full) => {
        const imgMatch = full.match(/<img [^>]*src="([^"]+)"/)
        if (imgMatch && imageUrls.has(imgMatch[1].split('?')[0])) {
          return '' // remove duplicate link
        }
        return full
      })
      return `<description><![CDATA[${cleaned}]]></description>`
    })
  } catch (err) {
    console.error('Duplicate cleaner error:', err)
  }

  // 4. Return cleaned RSS
  res
    .status(200)
    .setHeader('content-type', 'text/xml; charset=utf-8')
    .send(text)
}

export default handler
