import type { VercelApiHandler } from '@vercel/node'
import { request } from 'undici'

// Tracking parameters to remove
const TRACKING_PARAMS = [
  'ref_src', 'ref_url', 'tw', 's',
  'fbclid', 'fb_action_ids', 'fb_action_types', 'fb_source', 'fb_ref',
  'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'mc_cid', 'mc_eid', '_ga', 'msclkid', 'igshid', 'ref'
]

// Simple cache
const urlCache = new Map<string, { url: string; timestamp: number }>()
const CACHE_TTL = 24 * 60 * 60 * 1000

function getCachedUrl(url: string): string | null {
  const cached = urlCache.get(url)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.url
  }
  urlCache.delete(url)
  return null
}

function setCachedUrl(original: string, resolved: string): void {
  if (urlCache.size > 1000) {
    const firstKey = urlCache.keys().next().value
    if (firstKey) urlCache.delete(firstKey)
  }
  urlCache.set(original, { url: resolved, timestamp: Date.now() })
}

function cleanUrl(urlString: string): string {
  try {
    const url = new URL(urlString)
    
    // Remove tracking parameters
    TRACKING_PARAMS.forEach(param => url.searchParams.delete(param))
    
    // Remove utm_* pattern
    const paramsToDelete: string[] = []
    url.searchParams.forEach((_, key) => {
      if (/^utm_/i.test(key)) paramsToDelete.push(key)
    })
    paramsToDelete.forEach(param => url.searchParams.delete(param))
    
    // Twitter/X normalization
    if (/^(www\.)?(twitter|x)\.com$/.test(url.hostname)) {
      url.hostname = 'x.com'
    }
    
    // YouTube normalization
    if (url.hostname === 'youtu.be') {
      const videoId = url.pathname.slice(1)
      url.hostname = 'www.youtube.com'
      url.pathname = '/watch'
      url.search = ''
      url.searchParams.set('v', videoId)
    } else if (/youtube\.com$/.test(url.hostname)) {
      const videoId = url.searchParams.get('v')
      if (videoId) {
        url.search = ''
        url.searchParams.set('v', videoId)
      }
    }
    
    // Amazon cleanup - keep only ASIN
    if (/amazon\.(com|gr|de|co\.uk|fr|it|es)$/.test(url.hostname)) {
      const match = url.pathname.match(/\/dp\/([A-Z0-9]{10})/)
      if (match) {
        url.pathname = `/dp/${match[1]}`
        url.search = ''
      }
    }
    
    // Remove trailing slash
    if (url.pathname.endsWith('/') && url.pathname.length > 1) {
      url.pathname = url.pathname.slice(0, -1)
    }
    
    return url.toString()
  } catch {
    return urlString
  }
}

async function resolveUrl(url: string): Promise<{ final: string; fromCache: boolean }> {
  // Check cache first
  const cached = getCachedUrl(url)
  if (cached) {
    return { final: cached, fromCache: true }
  }

  let finalUrl = url
  let currentUrl = url
  
  // Manual redirect tracking (max 10 hops)
  for (let i = 0; i < 10; i++) {
    try {
      const response = await request(currentUrl, { 
        method: 'HEAD',
        maxRedirections: 0,
        headersTimeout: 5000,
        bodyTimeout: 5000
      })
      
      const statusCode = response.statusCode
      const location = response.headers.location
      
      if (statusCode >= 300 && statusCode < 400 && location) {
        currentUrl = new URL(location as string, currentUrl).href
      } else {
        finalUrl = currentUrl
        break
      }
    } catch {
      finalUrl = currentUrl
      break
    }
  }
  
  finalUrl = cleanUrl(finalUrl)
  setCachedUrl(url, finalUrl)
  
  return { final: finalUrl, fromCache: false }
}

// Rate limiting
const requestCounts = new Map<string, { count: number; resetTime: number }>()
const RATE_LIMIT_WINDOW = 15 * 60 * 1000
const RATE_LIMIT_MAX = 1000

function checkRateLimit(ip: string): { allowed: boolean; remaining: number } {
  const now = Date.now()
  
  if (requestCounts.size > 5000) {
    for (const [key, record] of requestCounts) {
      if (now > record.resetTime) requestCounts.delete(key)
    }
  }
  
  const record = requestCounts.get(ip)
  
  if (!record || now > record.resetTime) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW })
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 }
  }
  
  if (record.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0 }
  }
  
  record.count++
  return { allowed: true, remaining: RATE_LIMIT_MAX - record.count }
}

const handler: VercelApiHandler = async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || 
             req.headers['x-real-ip'] as string || 
             'unknown'
  
  const rateLimit = checkRateLimit(ip)
  res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX)
  res.setHeader('X-RateLimit-Remaining', rateLimit.remaining)
  
  if (!rateLimit.allowed) {
    return res.status(429).json({ 
      error: 'Too many requests',
      retryAfter: Math.ceil(RATE_LIMIT_WINDOW / 1000)
    })
  }

  const { text = '', cleanTracking = true } = (req.body || {}) as {
    text: string
    cleanTracking?: boolean
  }

  if (!text) {
    return res.status(400).json({ error: 'Text is required' })
  }

  // URLs σε plaintext
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+[^\s<>"{}|\\^`\[\].,;:!?)]/gi
  const plaintextMatches = text.match(urlRegex) || []
  
  // URLs μέσα σε HTML attributes
  const attributeRegex = /(?:href|src|data-[a-z-]+|content|cite|poster|action)=["'](https?:\/\/[^"']+)["']/gi
  const attributeMatches = [...text.matchAll(attributeRegex)].map(m => m[1])
  
  // URLs χωρίς quotes
  const unquotedRegex = /(?:href|src)=(https?:\/\/[^\s>]+)/gi
  const unquotedMatches = [...text.matchAll(unquotedRegex)].map(m => m[1])
  
  // Συνδύασε όλα
  const allMatches = [...plaintextMatches, ...attributeMatches, ...unquotedMatches]
  const uniqueUrls = [...new Set(allMatches)]

  if (uniqueUrls.length === 0) {
    return res.status(200).json({ 
      text,
      stats: { totalLinks: 0, expanded: 0, cleaned: 0, failed: 0, cached: 0 }
    })
  }

  // Parallel processing
  const results = await Promise.allSettled(
    uniqueUrls.map(url => resolveUrl(url))
  )

  const toReplace = new Map<string, string>()
  const stats = { totalLinks: uniqueUrls.length, expanded: 0, cleaned: 0, failed: 0, cached: 0 }

  results.forEach((result, i) => {
    const original = uniqueUrls[i]
    
    if (result.status === 'fulfilled') {
      const { final, fromCache } = result.value
      
      if (fromCache) stats.cached++
      
      if (final !== original) {
        toReplace.set(original, final)
        stats.expanded++
        if (cleanTracking) stats.cleaned++
      }
    } else {
      stats.failed++
    }
  })

  // Replace URLs παντού
  let resultText = text
  for (const [original, final] of toReplace) {
    const escapedOriginal = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const replaceRegex = new RegExp(escapedOriginal, 'g')
    resultText = resultText.replace(replaceRegex, final)
  }

  const responseObject = { text: resultText, stats }
  
  console.log('=== DEBUG INFO ===')
	console.log('Unique URLs found:', uniqueUrls)
	console.log('URLs to replace:', Array.from(toReplace.entries()))
	console.log('Stats object:', JSON.stringify(stats))
	console.log('Response size (bytes):', JSON.stringify(responseObject).length)
	console.log('==================')
    
  res.status(200).json(responseObject)
}

export default handler
