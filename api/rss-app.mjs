import { request } from 'undici';

// TRACKING PARAMS
const TRACKING_PARAMS = [
  'ref_src', 'ref_url', 'tw', 's',
  'fbclid', 'fb_action_ids', 'fb_action_types', 'fb_source', 'fb_ref',
  'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'mc_cid', 'mc_eid', '_ga', 'msclkid', 'igshid', 'ref'
];

const urlCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

function getCachedUrl(url) {
  const cached = urlCache.get(url);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.url;
  }
  urlCache.delete(url);
  return null;
}

function setCachedUrl(original, resolved) {
  if (urlCache.size > 1000) {
    const firstKey = urlCache.keys().next().value;
    if (firstKey) urlCache.delete(firstKey);
  }
  urlCache.set(original, { url: resolved, timestamp: Date.now() });
}

function cleanUrl(urlString) {
  try {
    const url = new URL(urlString);
    
    // Remove tracking parameters
    TRACKING_PARAMS.forEach(param => url.searchParams.delete(param));
    
    // Remove utm_* pattern
    const paramsToDelete = [];
    url.searchParams.forEach((_, key) => {
      if (/^utm_/i.test(key)) paramsToDelete.push(key);
    });
    paramsToDelete.forEach(param => url.searchParams.delete(param));
    
    // Twitter/X normalization
    if (/^(www\.)?(twitter|x)\.com$/.test(url.hostname)) {
      url.hostname = 'x.com';
    }
    
    // YouTube normalization
    if (url.hostname === 'youtu.be') {
      const videoId = url.pathname.slice(1);
      url.hostname = 'www.youtube.com';
      url.pathname = '/watch';
      url.search = '';
      url.searchParams.set('v', videoId);
    } else if (/youtube\.com$/.test(url.hostname)) {
      const videoId = url.searchParams.get('v');
      if (videoId) {
        url.search = '';
        url.searchParams.set('v', videoId);
      }
    }
    
    // Amazon cleanup
    if (/amazon\.(com|gr|de|co\.uk|fr|it|es)$/.test(url.hostname)) {
      const match = url.pathname.match(/\/dp\/([A-Z0-9]{10})/);
      if (match) {
        url.pathname = `/dp/${match[1]}`;
        url.search = '';
      }
    }
    
    // Remove trailing slash
    if (url.pathname.endsWith('/') && url.pathname.length > 1) {
      url.pathname = url.pathname.slice(0, -1);
    }
    
    return url.toString();
  } catch {
    return urlString;
  }
}

async function resolveUrl(url) {
  const cached = getCachedUrl(url);
  if (cached) return { final: cached, fromCache: true };

  let finalUrl = url;
  let currentUrl = url;
  
  for (let i = 0; i < 5; i++) {
    try {
      const response = await request(currentUrl, { 
        method: 'HEAD',
        maxRedirections: 0,
        headersTimeout: 3000,
        bodyTimeout: 3000
      });
      
      const statusCode = response.statusCode;
      const location = response.headers.location;
      
      if (statusCode >= 300 && statusCode < 400 && location) {
        currentUrl = new URL(location, currentUrl).href;
      } else {
        finalUrl = currentUrl;
        break;
      }
    } catch {
      finalUrl = currentUrl;
      break;
    }
  }
  
  finalUrl = cleanUrl(finalUrl);
  setCachedUrl(url, finalUrl);
  
  return { final: finalUrl, fromCache: false };
}

export default async function handler(req, res) {
  const { id } = req.query;

  try {
    console.log('=== RSS PROXY START ===');
    console.log('Feed ID:', id);
    
    // 1. Fetch RSS feed
    const { body } = await request(`https://rss.app/feeds/${id}.xml`);
    let text = await body.text();
    
    console.log('Original RSS size (bytes):', text.length);

    // 2. Pre-process: Remove escaped quotes
    let processedText = text.replace(/\\"/g, '"').replace(/\\'/g, "'");

    // 3. Extract ALL URLs
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+[^\s<>"{}|\\^`\[\].,;:!?)]/gi;
    const plaintextMatches = processedText.match(urlRegex) || [];
    
    const attributeRegex = /(?:href|src|data-[a-z-]+|content|cite|poster|action)=["'](https?:\/\/[^"']+)["']/gi;
    const attributeMatches = [...processedText.matchAll(attributeRegex)].map(m => m[1]);
    
    const allMatches = [...plaintextMatches, ...attributeMatches];
    const uniqueUrls = [...new Set(allMatches)];

    console.log('Unique URLs found:', uniqueUrls);

    // 4. Resolve all URLs in parallel
    const results = await Promise.allSettled(
      uniqueUrls.map(url => resolveUrl(url))
    );

    const toReplace = new Map();
    const stats = { totalLinks: uniqueUrls.length, expanded: 0, cleaned: 0, failed: 0, cached: 0 };

    results.forEach((result, i) => {
      const original = uniqueUrls[i];
      
      if (result.status === 'fulfilled') {
        const { final, fromCache } = result.value;
        
        if (fromCache) stats.cached++;
        
        if (final !== original) {
          toReplace.set(original, final);
          stats.expanded++;
          stats.cleaned++;
        }
      } else {
        stats.failed++;
      }
    });

    console.log('URLs to replace:', Array.from(toReplace.entries()));
    console.log('Stats:', JSON.stringify(stats));

    // 5. Replace URLs in original text
    for (const [original, final] of toReplace) {
      const escapedOriginal = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const replaceRegex = new RegExp(escapedOriginal, 'g');
      text = text.replace(replaceRegex, final);
    }

    console.log('Final RSS size (bytes):', text.length);
    console.log('=== RSS PROXY END ===');

    // 6. Return cleaned RSS
    res
      .status(200)
      .setHeader('content-type', 'text/xml; charset=utf-8')
      .setHeader('cache-control', 'public, max-age=300')
      .send(text);

  } catch (error) {
    console.error('=== RSS PROXY ERROR ===');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({ error: 'Failed to process RSS feed' });
  }
}
