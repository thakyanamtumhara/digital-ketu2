import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const SEED_FILTERS = [
  {
    name: 'acknowledgment',
    displayName: 'Acknowledgment',
    description: 'Skip messages that are just acknowledgments (ok, thanks, etc.) — 0 tokens',
    filterType: 'keyword',
    matchType: 'exact',
    action: 'skip',
    keywords: [
      'ok', 'okay', 'fine', 'sure', 'thanks', 'thank you', 'alright',
      'got it', 'noted', 'understood', 'no problem', 'np', 'cool',
      'great', 'good', 'right', 'yes', 'yep', 'ya', 'yaa',
      'theek hai', 'thik hai', 'accha', 'acha', 'sahi hai',
      'ji', 'haan', 'ha', 'dhanyavaad', 'shukriya', 'bas',
      'theek', 'thik', 'achchha', 'hmm', 'hm', 'k', 'kk',
      'done', 'bilkul', 'zaroor', 'thx', 'ty',
    ].join(','),
    priority: 10,
  },
  {
    name: 'greeting',
    displayName: 'Greeting',
    description: 'Detect greetings for welcome message bypass — sends welcome to first-time/returning buyers',
    filterType: 'keyword',
    matchType: 'exact',
    action: 'welcome_bypass',
    keywords: [
      'hi', 'hello', 'hey', 'hii', 'hiii', 'hiiii',
      'helo', 'hllo', 'helloo', 'hellooo',
      'namaste', 'namaskar', 'namaskaar',
      'good morning', 'good afternoon', 'good evening',
      'gm', 'morning', 'evening',
      'hy', 'hye', 'hola', 'yo',
    ].join(','),
    priority: 20,
  },
      // DEFUSED 2026-08-27: never enable as auto_reply — 'Ok noted sir 👍' would fire on complaints, cancellations and bulk leads.
{
    name: 'informing',
    displayName: 'Informing / Status Update',
    description: 'Auto-reply to buyer status updates and purchase confirmations — 0 tokens',
    filterType: 'keyword',
    matchType: 'partial',
    action: 'defer',
    enabled: false,
    autoReplyText: 'Ok noted sir 👍',
    keywords: [
      'just to inform', 'inform', 'batana tha', 'bata raha', 'bata rahi',
      'plan hai', 'plan kar', 'planning', 'soch raha', 'soch rahi', 'socha hai',
      'future mein', 'future me', 'aage', 'baad mein', 'baad me',
      'winter mein', 'winter me', 'summer mein', 'summer me',
      'this winter', 'this summer', 'next month', 'next year',
      'coming winter', 'coming summer', 'coming month',
      'will be buying', 'will buy', 'will order', 'will need',
      'lene wala', 'lene wale', 'lenge', 'karenge', 'karunga', 'karungi',
      'lunga', 'lungi', 'mangwaunga', 'mangwaungi',
      'most probably', 'probably', 'shayad',
      'video dekhi', 'video dekha', 'reel dekhi', 'reel dekha',
      'interested', 'interest hai',
      'purchased', 'order kiya', 'order kar diya', 'order de diya',
      'order place kiya', 'order placed', 'order kar diya hai',
      'website se order', 'website se liya', 'website pe order',
      'online order', 'order done', 'order ho gaya',
      'le liya', 'kharid liya', 'khareed liya',
      'payment kar diya', 'payment done', 'pay kar diya',
    ].join(','),
    priority: 30,
  },
      // DEFUSED 2026-08-27: never enable as auto_reply — would tell a buyer whose payment is failing that the site is fine.
{
    name: 'website_issue',
    displayName: 'Website Issue',
    description: 'Auto-reply to website/app access issues — 0 tokens',
    filterType: 'keyword',
    matchType: 'combo',
    action: 'defer',
    enabled: false,
    autoReplyText: 'Sir, issue toh nahi hai. Network ya server ka temporary issue hoga. Thodi der baad try kariye, open ho jaayega 👍',
    keywords: JSON.stringify({
      siteWords: ['site', 'website', 'sale91', 'page'],
      issueWords: ['issue', 'problem', 'error', 'down', 'nahi', 'ni', 'nhi', 'not'],
      directKws: [
        'open nahi', 'open ni', 'open nhi', 'khul nahi', 'khul ni', 'khul nhi',
        'nahi khul', 'nhi khul', 'not opening', 'not working', 'not loading',
        'load nahi', 'blank page', 'page not found', 'server error',
      ],
      excludeWords: ['product', 'tshirt', 't-shirt', 'shirt', 'item', 'listed', 'price', 'rate', 'photo', 'image', 'color', 'colour', 'size'],
    }),
    priority: 40,
  },
  {
    name: 'angry_buyer',
    displayName: 'Angry Buyer',
    description: 'Defer angry/abusive messages to Ketu immediately',
    filterType: 'keyword',
    matchType: 'partial',
    action: 'defer',
    keywords: [
      'bakwas', 'bekar', 'ghatiya', 'worst', 'scam', 'fraud', 'cheat',
      'dhoka', 'dhokha', 'complaint', 'consumer forum', 'legal',
      'reply nahi karte', 'response nahi', 'koi jawab nahi',
      'bahut bura', 'very bad', 'terrible', 'horrible', 'pathetic',
      'pagal', 'bewakoof', 'stupid',
    ].join(','),
    priority: 50,
  },
]

async function seedFilters() {
  console.log('Seeding Pre-AI filters...')

  for (const filter of SEED_FILTERS) {
    await db.preAIFilter.upsert({
      where: { name: filter.name },
      update: {}, // Don't overwrite if already exists (user may have edited)
      create: {
        ...filter,
        isSystem: true,
        enabled: true,
      },
    })
    const kwCount = filter.matchType === 'combo'
      ? 'combo logic'
      : filter.keywords.split(',').length + ' keywords'
    console.log(`  ✓ ${filter.displayName} (${kwCount})`)
  }

  console.log('Done! All Pre-AI filters seeded.')
}

seedFilters()
  .catch(console.error)
  .finally(() => db.$disconnect())
