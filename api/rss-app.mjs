import { request } from 'undici'
import { JSDOM } from 'jsdom'

const DOMAINS = [
  't.co', 'bit.ly', 'tinyurl.com', 'goo.gl', 'ow.ly', 'buff.ly',
  'rebrand.ly', 'is.gd', 'soo.gd', 's.id', 'cutt.ly'
]

export default async function handler(req, res) {
  const { id } = req.query

  try {
    // 1. Fetch RSS feed
    const { body } = await request(`https://rss.app/feeds/${id}`)
    let text = await body.text()

    // 2. Expand shortlinks
    const domainsGroup = DOMAINS.map(d => d.replace(/\./g, '\\.')).join('|')
    const occurences = text.matchAll(
      new RegExp(`https?://(?:${domainsGroup})/\\w+`, 'g')
    )

    const toReplace = new Map()
    for (const [link] of occurences) {
      if (toReplace.has(link)) continue
      try {
        const { headers: { location } } = await request(link, { method: 'HEAD' })
        if (typeof location === 'string') toReplace.set(link, location)
      } catch {
        toReplace.set(link, link)
      }
    }

    for (const [link, resolvedUrl] of toReplace) {
      text = text.replaceAll(link, resolvedUrl)
    }

    // 3. Remove duplicate pic.twitter.com images
    const dom = new JSDOM(text, { contentType: 'text/xml' })
    const doc = dom.window.document

    doc.querySelectorAll('item').forEach(item => {
      const seen = new Set()

      // Collect all enclosure/media:content images
      item.querySelectorAll('enclosure, media\\:content').forEach(node => {
        const url = node.getAttribute('url')
        if (url) seen.add(url.split('?')[0])
      })

      // Remove <a href="https://pic.twitter.com/..."> inside description if duplicate
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

        // Write cleaned description back
        descNode.textContent = descDoc.body.innerHTML
      }
    })

    text = dom.serialize()

    // 4. Return cleaned RSS
    res
      .status(200)
      .setHeader('content-type', 'text/xml; charset=utf-8')
      .send(text)
  } catch (err) {
    console.error('Handler error:', err)
    res.status(500).send('Internal Server Error')
  }
}
