const { request } = require('undici');

const DOMAINS = [
  't.co', 'bit.ly', 'tinyurl.com', 'goo.gl', 'ow.ly', 'buff.ly',
  'rebrand.ly', 'is.gd', 'soo.gd', 's.id', 'cutt.ly'
];

module.exports = async (req, res) => {
  const { id } = req.query;

  try {
    // 1. Fetch RSS feed
    const { body } = await request(`https://rss.app/feeds/${id}`);
    let text = await body.text();

    // 2. Expand shortlinks
    const domainsGroup = DOMAINS.map(d => d.replace(/\./g, '\\.')).join('|');
    const occurences = [...text.matchAll(new RegExp(`https?://(?:${domainsGroup})/\\w+`, 'g'))];

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
      text = text.replaceAll(link, resolvedUrl);
    }

    // 3. Remove duplicate pic.twitter.com images
    // Keep track of seen images (without query params)
    const seenImages = new Set();

    text = text.replace(/<item>[\s\S]*?<\/item>/g, itemBlock => {
      // Collect image URLs from enclosure/media:content
      const imgUrls = [...itemBlock.matchAll(/<enclosure[^>]+url="([^"]+)"/g)]
        .map(m => m[1].split('?')[0]);
      const mediaUrls = [...itemBlock.matchAll(/<media:content[^>]+url="([^"]+)"/g)]
        .map(m => m[1].split('?')[0]);
      imgUrls.concat(mediaUrls).forEach(url => seenImages.add(url));

      // Remove pic.twitter.com links in description if already seen
      const cleanedItem = itemBlock.replace(
        /<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/,
        (match, descContent) => {
          const cleanedDesc = descContent.replace(
            /<a href="https:\/\/pic\.twitter\.com\/[^"]+"><img[^>]+><\/a>/g,
            aTag => {
              const srcMatch = aTag.match(/src="([^"]+)"/);
              if (!srcMatch) return aTag;
              const imgSrc = srcMatch[1].split('?')[0];
              if (seenImages.has(imgSrc)) return '';
              seenImages.add(imgSrc);
              return aTag;
            }
          );
          return `<description><![CDATA[${cleanedDesc}]]></description>`;
        }
      );

      return cleanedItem;
    });

    // 4. Return cleaned RSS
    res
      .status(200)
      .setHeader('content-type', 'text/xml; charset=utf-8')
      .send(text);

  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
};
	
