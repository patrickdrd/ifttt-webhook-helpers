import type { VercelApiHandler } from '@vercel/node'
import { request } from 'undici'

// Default shortener domains
const DEFAULT_DOMAINS = [
  't.co', 'bit.ly', 'tinyurl.com', 'goo.gl', 'ow.ly', 'buff.ly',
  'rebrand.ly', 'is.gd', 'soo.gd', 's.id', 'cutt.ly'
]

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
    
    // Remove Echobox tracking from hash
    if (url.hash && url.hash.match(/#Echobox=\d+-\d+/)) {
      url.hash = ''
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
  const cached = getCachedUrl(url)
  if (cached) {
    return { final: cached, fromCache: true }
  }

  let finalUrl = url
  let currentUrl = url
  
  // Manual redirect tracking (max 5 hops)
  for (let i = 0; i < 5; i++) {
    try {
      const response = await request(currentUrl, { 
        method: 'HEAD',
        maxRedirections: 0,
        headersTimeout: 3000,
        bodyTimeout: 3000
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

const handler: VercelApiHandler = async (req, res) => {
  let { text = '', domains = [], cleanTracking = true } = req.body as {
    text: string
    domains?: string[]
    cleanTracking?: boolean
  }

  if (!text) {
    return res.status(400).json({ error: 'Text is required' })
  }

  console.log('=== RESOLVE-LINKS START ===')

  // Use default domains if none provided
  const domainsToUse = domains.length > 0 ? domains : DEFAULT_DOMAINS
  
  // Pre-process: Remove escaped quotes
  let processedText = text.replace(/\\"/g, '"').replace(/\\'/g, "'")

  // Build domain regex
  const domainsGroup = domainsToUse.map(d => d.replace(/\./g, '\\.')).join('|')
  const domainRegex = new RegExp(`https?://(?:${domainsGroup})/\\w+`, 'g')
  const domainMatches = processedText.match(domainRegex) || []

  // Also find URLs in HTML attributes
  const attributeRegex = /(?:href|src|data-[a-z-]+|content)=["'](https?:\/\/[^"']+)["']/gi
  const attributeMatches = [...processedText.matchAll(attributeRegex)].map(m => m[1])
  
  // Combine and deduplicate
  const allMatches = [...domainMatches, ...attributeMatches]
  const uniqueUrls = [...new Set(allMatches)]

  console.log('Unique URLs found:', uniqueUrls)

  if (uniqueUrls.length === 0) {
    console.log('No URLs to process')
    console.log('=== RESOLVE-LINKS END ===')
    return res.json({ text, stats: { totalLinks: 0, expanded: 0, cleaned: 0, failed: 0, cached: 0 } })
  }

  // Resolve all URLs in parallel
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

  console.log('URLs to replace:', Array.from(toReplace.entries()))
  console.log('Stats:', JSON.stringify(stats))

  // Replace URLs in original text
  let resultText = text
  for (const [original, final] of toReplace) {
    const escapedOriginal = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const replaceRegex = new RegExp(escapedOriginal, 'g')
    resultText = resultText.replace(replaceRegex, final)
  }

  console.log('=== RESOLVE-LINKS END ===')

  res.json({ text: resultText, stats })
}

export default handler
