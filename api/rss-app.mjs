import { request } from 'undici';

const DOMAINS = [
  't.co', 'bit.ly', 'tinyurl.com', 'goo.gl', 'ow.ly', 'buff.ly',
  'rebrand.ly', 'is.gd', 'soo.gd', 's.id', 'cutt.ly'
];

export default async function handler(req, res) {
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



  // 4. Return cleaned RSS
  res
    .status(200)
    .setHeader('content-type', 'text/xml; charset=utf-8')
    .send(text);
}
