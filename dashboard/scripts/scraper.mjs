import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, '..', 'public', 'data', 'instagram.json');

const ACCOUNTS = [
  { id: 'daimotorsmcbo', handle: 'daimotorsmcbo' },
  { id: 'cherymaracaibo', handle: 'cherymaracaibo' },
  { id: 'yantaimotors', handle: 'yantaimotors' },
  { id: 'kyotomotorsmcbo', handle: 'kyotomotorsmcbo' },
  { id: 'repuestoskiamcbo', handle: 'repuestoskiamcbo' },
];

function parseCount(text) {
  if (!text) return 0;
  const t = text.trim().toLowerCase();
  if (t.includes('k')) return Math.round(parseFloat(t.replace('k', '')) * 1000);
  if (t.includes('m')) return Math.round(parseFloat(t.replace('m', '')) * 1000000);
  return parseInt(t.replace(/[.,]/g, '')) || 0;
}

async function scrapeProfile(page, handle) {
  const url = `https://www.instagram.com/${handle}/`;
  console.log(`  🌐 ${url}`);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Wait a bit for JS to execute
    await page.waitForTimeout(5000);
  } catch (err) {
    console.warn(`  ⚠️  timeout navegando, intentando extraer igual...`);
  }

  let followers = 0;
  let posts = 0;
  let following = 0;
  let bio = '';

  // Method 1: Extract from og:title meta tag (always has follower count)
  try {
    const ogTitle = await page.getAttribute('meta[property="og:title"]', 'content');
    if (ogTitle) {
      const m = ogTitle.match(/([\d,.]+[kKmMbB]?)\s*(?:seguidores|follower[s]?)/i);
      if (m) followers = parseCount(m[1]);
      console.log(`  📋 og:title = "${ogTitle}"`);
    }
  } catch { /* ignore */ }

  // Method 2: Extract from og:description (has followers, following, posts)
  try {
    const ogDesc = await page.getAttribute('meta[property="og:description"]', 'content');
    if (ogDesc) {
      const fm = ogDesc.match(/([\d,.]+[kKmMbB]?)\s*(?:seguidores|follower[s]?)/i);
      if (!followers && fm) followers = parseCount(fm[1]);
      const pm = ogDesc.match(/([\d,.]+)\s*(?:publicaciones|posts)/i);
      if (!posts && pm) posts = parseCount(pm[1]);
      const fwm = ogDesc.match(/([\d,.]+[kKmMbB]?)\s*(?:siguiendo|following)/i);
      if (!following && fwm) following = parseCount(fwm[1]);
      console.log(`  📋 og:desc = "${ogDesc}"`);
    }
  } catch { /* ignore */ }

  // Method 3: Parse window.__INITIAL_STATE__ or __NEXT_DATA__ or __ Apollo state
  try {
    const jsonStr = await page.evaluate(() => {
      // Try script#__NEXT_DATA__ (Next.js)
      const nextData = document.getElementById('__NEXT_DATA__');
      if (nextData) return nextData.textContent;

      // Try __INITIAL_STATE__
      if (window.__INITIAL_STATE__) return JSON.stringify(window.__INITIAL_STATE__);

      // Try window._sharedData
      if (window._sharedData) return JSON.stringify(window._sharedData);

      return null;
    });

    if (jsonStr) {
      const data = JSON.parse(jsonStr);
      // Try to extract profile data from various structures
      const profile =
        data?.props?.pageProps?.profileData ||
        data?.entry_data?.ProfilePage?.[0]?.graphql?.user ||
        data?.profileData ||
        data?.user;

      if (profile) {
        if (!followers && profile.edge_followed_by?.count) followers = profile.edge_followed_by.count;
        else if (!followers && profile.follower_count) followers = profile.follower_count;
        if (!posts && profile.edge_owner_to_timeline_media?.count) posts = profile.edge_owner_to_timeline_media.count;
        else if (!posts && profile.media_count) posts = profile.media_count;
        if (!following && profile.edge_follow?.count) following = profile.edge_follow.count;
        else if (!following && profile.following_count) following = profile.following_count;
        if (!bio && profile.biography) bio = profile.biography;
        console.log(`  📦 Profile data from script tag`);
      }
    }
  } catch { /* ignore */ }

  // Method 4: Grab all visible text and find numbers
  if (!followers || !posts) {
    try {
      const bodyText = await page.evaluate(() => document.body.innerText);
      const lines = bodyText.split('\n').filter(l => l.trim());

      // Look for follower count
      for (const line of lines) {
        const trimmed = line.trim();
        // First line with a number is usually posts count
        if (!posts && /^\d/.test(trimmed)) {
          const num = parseInt(trimmed.replace(/[.,]/g, ''));
          if (num > 0 && num < 100000) posts = num;
        }
      }

      // Find follower count in text
      const followerMatch = bodyText.match(/([\d,.]+[kKmMbB]?)\s*(?:seguidores|follower[s]?)/i);
      if (!followers && followerMatch) followers = parseCount(followerMatch[1]);

      // Find following
      const followingMatch = bodyText.match(/([\d,.]+[kKmMbB]?)\s*(?:siguiendo|following)/i);
      if (!following && followingMatch) following = parseCount(followingMatch[1]);

      // Bio - often in a span[dir="auto"]
      const bioMatch = bodyText.match(/(Concesionario|Centro de|Somos el)[^◈\n]{5,100}/i);
      if (!bio && bioMatch) bio = bioMatch[0].trim();

      console.log(`  📝 Extraído de texto de página`);
    } catch { /* ignore */ }
  }

  // Method 5: Extract recent posts from og:url and similar meta
  let recentPosts = [];
  try {
    // Try to get post links from the page
    const ogUrl = await page.getAttribute('meta[property="og:url"]', 'content');
    if (ogUrl) {
      // The profile page URL itself - not a post
    }

    // Try extracting from the JSON-LD script tag
    const jsonLd = await page.evaluate(() => {
      const el = document.querySelector('script[type="application/ld+json"]');
      return el?.textContent || null;
    });
    if (jsonLd) {
      try {
        const parsed = JSON.parse(jsonLd);
        const items = parsed?.mainEntity?.itemListElement || [];
        for (const item of items.slice(0, 3)) {
          const url = item?.url || item?.['@id'];
          if (url && url.includes('/p/')) {
            recentPosts.push({ url });
          }
        }
      } catch { /* ignore */ }
    }

    // Fallback: try clicking and scrolling to trigger post load
    if (recentPosts.length === 0) {
      await page.evaluate(() => window.scrollBy(0, 800));
      await page.waitForTimeout(2000);
      const links = await page.$$('a[href*="/p/"]');
      const seen = new Set();
      for (const link of links) {
        const href = await link.getAttribute('href');
        if (!href || seen.has(href)) continue;
        seen.add(href);
        const fullUrl = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
        if (fullUrl.includes('/p/')) recentPosts.push({ url: fullUrl });
        if (recentPosts.length >= 3) break;
      }
    }
    if (recentPosts.length > 0) console.log(`  📸 ${recentPosts.length} posts recientes`);
  } catch { /* ignore */ }

  console.log(`  ✅ ${handle}: ${followers} seg, ${posts} posts, ${following} sig`);
  return { id: handle, followers, posts, following, bio, recentPosts };
}

async function main() {
  console.log('🚀 Cavo Scraper — Instagram\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'es-ES',
    extraHTTPHeaders: {
      'Accept-Language': 'es-ES,es;q=0.9',
    },
  });
  const page = await context.newPage();

  const results = [];
  for (const acc of ACCOUNTS) {
    try {
      const data = await scrapeProfile(page, acc.handle);
      results.push({ id: acc.id, ...data });
    } catch (err) {
      console.error(`  ❌ ${acc.handle}: ${err.message}`);
      results.push({ id: acc.id, followers: 0, posts: 0, following: 0, bio: '' });
    }
  }

  await browser.close();

  const output = {
    scrapedAt: new Date().toISOString(),
    accounts: results,
  };

  writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));
  console.log(`\n📁 Datos guardados en ${DATA_FILE}`);
  console.log(`⏱  ${new Date().toLocaleString('es-VE')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
