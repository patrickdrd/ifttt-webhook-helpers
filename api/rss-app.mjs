// api/rss-app.mjs
export default async function handler(req, res) {
  const DOMAINS = [
    't.co','bit.ly','tinyurl.com','goo.gl','ow.ly','buff.ly',
    'rebrand.ly','is.gd','soo.gd','s.id','cutt.ly'
  ];

  function canonicalizeUrl(u) {
    if (!u) return null;
    try {
      const url = new URL(u, 'https://example.invalid');
      url.search = '';
      url.hash = '';
      // remove twitter size suffixes like :large :orig :small :thumb
      return (url.origin + url.pathname).replace(/:(large|orig|small|thumb)$/i, '');
    } catch {
      return u.split('?')[0].replace(/:(large|orig|small|thumb)$/i, '');
    }
  }

  try {
    const id = (req.query && req.query.id) || req.url && new URL(req.url, 'http://localhost').searchParams.get('id');
    if (!id) {
      res.statusCode = 400;
      res.end('Missing id query parameter');
      return;
    }

    // 1) Fetch RSS
    const feedResp = await fetch(`https://rss.app/feeds/${encodeURIComponent(id)}`);
    if (!feedResp.ok) {
      res.statusCode = feedResp.status;
      res.end(`Failed to fetch feed: ${feedResp.status}`);
      return;
    }
    let text = await feedResp.text();

    // 2) Expand short links (gather unique short links first)
    const domainsGroup = DOMAINS.map(d => d.replace(/\./g, '\\.')).join('|');
    const shortUrlRegex = new RegExp(`https?://(?:${domainsGroup})/\\w+`, 'g');
    const matches = Array.from(text.matchAll(shortUrlRegex)).map(m => m[0]);
    const uniqueShorts = Array.from(new Set(matches));

    // helper to resolve one link (HEAD then GET fallback)
    async function resolveOne(link) {
      try {
        // HEAD first (follow redirects)
        const r = await fetch(link, { method: 'HEAD', redirect: 'follow' });
        if (r && r.url && r.url !== link) return r.url;
      } catch (e) { /* ignore and fallback */ }

      try {
        // fallback to a GET with a small range header to avoid full download
        const r2 = await fetch(link, { method: 'GET', redirect: 'follow', headers: { Range: 'bytes=0-0' } });
        if (r2 && r2.url && r2.url !== link) return r2.url;
      } catch (e) { /* give up */ }
      return link;
    }

    // process in limited concurrency (batches)
    const BATCH_SIZE = 8;
    const replacements = new Map();
    for (let i = 0; i < uniqueShorts.length; i += BATCH_SIZE) {
      const batch = uniqueShorts.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(u => resolveOne(u).catch(() => u)));
      batch.forEach((orig, idx) => replacements.set(orig, results[idx] || orig));
    }

    // apply replacements
    for (const [orig, resolved] of replacements) {
      if (orig === resolved) continue;
      // replaceAll is available in Node 18+. fallback to split/join if needed
      if (String.prototype.replaceAll) text = text.replaceAll(orig, resolved);
      else text = text.split(orig).join(resolved);
    }

    // 3) Remove duplicate pic.twitter.com anchors per <item>
    // We'll process each <item>...</item> block independently
    const itemRegex = /<item>[\s\S]*?<\/item>/gi;
    text = text.replace(itemRegex, itemBlock => {
      // collect enclosure/media:content urls (canonicalized)
      const enclosureUrls = Array.from(itemBlock.matchAll(/<enclosure[^>]*\surl="([^"]+)"[^>]*>/gi)).map(m => canonicalizeUrl(m[1]));
      const mediaUrls = Array.from(itemBlock.matchAll(/<media:content[^>]*\surl="([^"]+)"[^>]*>/gi)).map(m => canonicalizeUrl(m[1]));
      const seen = new Set([...enclosureUrls, ...mediaUrls].filter(Boolean));

      // Replace pic.twitter.com anchors that wrap images if their img src is already in seen.
      // This covers patterns like: <a href="https://pic.twitter.com/..."><img src="..."></a>
      const cleaned = itemBlock.replace(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i, (match, cdata) => {
        let desc = cdata;

        // Replace anchor+img chunks:
        desc = desc.replace(/<a[^>]*href="https?:\/\/pic\.twitter\.com\/[^"]*"[^>]*>(?:\s*<img[^>]*>\s*)*<\/a>/gi, anchorHtml => {
          const srcMatch = anchorHtml.match(/<img[^>]*\bsrc\s*=\s*"([^"]+)"[^>]*>/i);
          if (!srcMatch) return anchorHtml; // leave as-is if no img found
          const imgSrcCanon = canonicalizeUrl(srcMatch[1]);
          if (seen.has(imgSrcCanon)) {
            // drop duplicate anchor entirely
            return '';
          } else {
            // keep and record it
            seen.add(imgSrcCanon);
            return anchorHtml;
          }
        });

        return `<description><![CDATA[${desc}]]></description>`;
      });

      return cleaned;
    });

    // 4) Return cleaned RSS
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    // prefer res.end for compatibility
    res.end(text);

  } catch (err) {
    console.error('rss-app handler error', err);
    res.statusCode = 500;
    res.end('Internal Server Error');
  }
}
