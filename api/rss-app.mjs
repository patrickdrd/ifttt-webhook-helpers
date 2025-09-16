import { request } from 'undici'
import { JSDOM } from 'jsdom'

const SHORTENER_DOMAINS = [
  't.co', 'bit.ly', 'tinyurl.com', 'goo.gl', 'ow.ly', 'buff.ly',
  'rebrand.ly', 'is.gd', 'soo.gd', 's.id', 'cutt.ly'
]

export default async function handler(req, res) {
  try {
    const { id } = req.query
    if (!id) {
      res.status(400).json({ error: 'Missing id parameter' })
      return
    }

    // 1. Fetch RSS feed
    const { body } = await request(`https://rss.app/feeds/${id}`)
    let text = await body.text()

    // 2. Resolve shortener links in parallel
    const domainsRegex = SHORTENER_DOMAINS.map(d => d.replace(/\./g, '\\.')).join('|')
    const matches = [...text.matchAll(new RegExp(`https?://(?:${domainsRegex})/[\\w\\d-_]+`, 'gi'))]
    const uniqueLinks = [...new Set(matches.map(([url]) => url))]

    const results = await Promise.all(
      uniqueLinks.map(async url => {
        try {
          const { headers: { location } } = await request(url, { method: 'HEAD' })
          return [url, location || url]
        } catch {
          return [url, url]
        }
      })
    )

    for (const [short, resolved] of results) {
      text = text.replaceAll(short, resolved)
    }

    // 3. Remove duplicate pic.twitter.com images
    try {
      const dom = new JSDOM(text, { contentType: 'text/xml' })
      const doc = dom.window.document

      doc.querySelectorAll('item').forEach(item => {
        const seen = new Set()

        // Collect images from <enclosure> and <media:content>
        item.querySelectorAll('enclosure, media\\:content').forEach(node => {
          const url = node.getAttribute('url')
          if (url) seen.add(url.split('?')[0])
        })

        const descNode = item.querySelector('description')
        if (descNode && descNode.textContent) {
          const descDom = new JSDOM(descNode.textContent)
          const descDoc = descDom.window.document

          descDoc.querySelectorAll('a[href*="pic.twitter.com"]').forEach(link => {
            const img = link.querySelector('img')
            if (img && seen.has(img.src.split('?')[0])) {
              link.remove()
            }
          })

          descNode.textContent = descDoc.body.innerHTML
        }
      })

      text = dom.serialize()
    } catch (err) {
      console.error('Duplicate pic.twitter.com cleaner error:', err)
    }

    // 4. Return cleaned RSS
    res
      .status(200)
      .setHeader('Content-Type', 'text/xml; charset=utf-8')
      .send(text)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
}
