// Regression: GSM-ALONE RESOLVER (2026-09-06). Pure.
import { gsmAmbiguityHint, catalogProductsFromChunks } from '../server/gsm-hint.js'
const P = catalogProductsFromChunks([
  { title: 'True Biowash Round Neck', metadata: { gsm: 180, bulkPrice: 150 } },
  { title: 'Biowash Round Neck', metadata: JSON.stringify({ gsm: 180, bulkPrice: 142 }) },
  { title: 'Oversize 180gsm', metadata: { gsm: 180, bulkPrice: 177 } },
  { title: 'Oversize 240gsm', metadata: { gsm: 240, bulkPrice: 195 } },
  { title: 'AcidWash Oversize', metadata: { gsm: 240, bulkPrice: 238 } },
  { title: 'Shorts', metadata: { gsm: 240, bulkPrice: 217 } },
  { title: 'Cotton Polo', metadata: { gsm: 220, bulkPrice: 187 } },
  { title: 'Premium Polo', metadata: { gsm: 220, bulkPrice: 237 } },
  { title: 'No GSM product', metadata: {} },
])
let pass = 0, total = 0
const t = (name, got, want) => { total++; const ok = got === want; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name.padEnd(60)} got=${got} want=${want}`) }
const h = gsmAmbiguityHint(P, '180 gsm pe\n10+ piece pe kya price lgega??')
t('MISS 15:36: bare 180 gsm → hint fires', !!h, true)
t('hint lists all three 180 products with prices', /True Biowash Round Neck \(bulk ₹150\).*Biowash Round Neck \(bulk ₹142\).*Oversize 180gsm \(bulk ₹177\)/.test(h || ''), true)
t('240 gsm (plain + speciality) → LEAD line, no ask', /LEAD with Oversize 240gsm ₹195/.test(gsmAmbiguityHint(P, '240 gsm 100 pcs ka rate') || ''), true)
t('180 gsm (different fits) → ASK line', /180gsm exists in 3 products.*ASK the fit/.test(gsmAmbiguityHint(P, '180 gsm ka rate') || ''), true)
t('180 gsm oversize (fit named) → no hint', gsmAmbiguityHint(P, '180 gsm oversize ka rate'), null)
t('round neck 180 (family named) → no hint', gsmAmbiguityHint(P, 'Round neck t shirt how much 180 gsn'), null)
t('220 gsm polo (named) → no hint', gsmAmbiguityHint(P, '220 gsm polo ka rate'), null)
t('bare 220 gsm → hint (two polos)', /220gsm exists in 2 products/.test(gsmAmbiguityHint(P, '220 gsm kitne ki hai') || ''), true)
t('"180 gsn" typo counts', !!gsmAmbiguityHint(P, 'plain tshirt 180 gsn price'), true)
t('no gsm → nothing', gsmAmbiguityHint(P, 'black tshirt ka rate'), null)
t('unknown gsm → nothing', gsmAmbiguityHint(P, '300 gsm hai?'), null)
console.log(`\n${pass}/${total} passed`); process.exit(pass === total ? 0 : 1)
