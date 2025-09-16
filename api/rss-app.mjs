const { request } = require('undici');

const DOMAINS = [
  't.co', 'bit.ly', 'tinyurl.com', 'goo.gl', 'ow.ly', 'buff.ly',
  'rebrand.ly', 'is.gd', 'soo.gd', 's.id', 'cutt.ly'
];

module.exports = async function handler(req, res) {
  const { id } = req.query;

  // 1. Fetch RSS feed
  const { body } = await request(`https://rss.app/feeds/${id}`);
  let text = await body.text();

  // 2. Expand shortlinks
  const domainsGroup = DOMAINS.map(d => d.replace(/\./g, '\\.')).join('|');
  const occurences = text.matchAll(new RegExp(`https?://(?:${domainsGroup})/\\w+`, 'g'));

  const toReplace = new Map();
  for (const [link] of occurences) {
    if (toReplace.has(link)) continue;
    try {
      const { headers: { location } } = await request(link, { method: 'HEAD' });
      toReplace.set(link, typeof location === 'string' ? location : link);
    } catch {
      toReplace.set(link, link);
    }
  }

  for (const [link, resolvedUrl] of toReplace) {
    text = text.replace(new RegExp(link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), resolvedUrl);
  }

  // 3. Remove duplicate pic.twitter.com images
  try {
    const imageUrls = new Set();
    const imgRegex = /<(?:enclosure|media:content)[^>]+url="([^"]+)"/g;
    let match;
    while ((match = imgRegex.exec(text)) !== null) {
      imageUrls.add(match[1].split('?')[0]);
    }

    text = text.replace(/<description><!\[CDATA\[(.*?)\]\]><\/description>/gs, (_, inner) => {
      let cleaned = inner;
      const aRegex = /<a [^>]*href="https:\/\/pic\.twitter\.com\/[^"]+"[^>]*>(.*?)<\/a>/gs;
      cleaned = cleaned.replace(aRegex, full => {
        const imgMatch = full.match(/<img [^>]*src="([^"]+)"/);
        if (imgMatch && imageUrls.has(imgMatch[1].split('?')[0])) {
          return '';
        }
        return full;
      });
      return `<description><![CDATA[${cleaned}]]></description>`;
    });
  } catch (err) {
    console.error('Duplicate cleaner error:', err);
  }

  // 4. Return cleaned RSS
  res
    .status(200)
    .setHeader('content-type', 'text/xml; charset=utf-8')
    .send(text);
};
