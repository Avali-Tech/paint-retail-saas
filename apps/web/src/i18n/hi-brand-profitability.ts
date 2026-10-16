// Hindi messages for brand profitability (draft: see docs/translations/glossary.md).
// Same keys as en-brand-profitability.ts.
import type { brandProfitabilityEn, brandProfitabilityEnumsEn } from './en-brand-profitability.js';
import type { Translation } from './shape.js';

export const brandProfitabilityHi: Translation<typeof brandProfitabilityEn> = {
  brandProfitability: {
    nav: 'ब्रांड मुनाफ़ा',
    title: 'ब्रांड मुनाफ़ा',
    description: 'लागत, उधार और पॉइंट के बाद हर ब्रांड ने असल में कितना कमाया।',
    error: 'ब्रांड मुनाफ़ा लोड नहीं हो सका',
    filters: 'फ़िल्टर',
    period: 'अवधि',
    from: 'से',
    to: 'तक',
    allStores: 'मेरे सभी स्टोर',
    splitBy: 'इसके हिसाब से बांटें',
    costOfMoney: 'पैसे की लागत (% सालाना)',
    costOfMoneyHint: 'ग्राहकों के पास फंसे पैसे की लागत; खाली छोड़ें तो आपकी सेटिंग',
    brandFilter: 'ब्रांड: {name}',
    allBrands: 'सभी ब्रांड दिखाएं',
    split: '{name} को प्रोडक्ट के हिसाब से बांटें',
    csv: 'CSV डाउनलोड करें',
    csvFailed: 'रिपोर्ट डाउनलोड नहीं हो सकी',
    periodRange: '{from} से {to}',
    settings: {
      open: 'सेटिंग',
      title: 'मुनाफ़े की सेटिंग',
      description: 'ब्रांड मुनाफ़े के सभी आंकड़े इन्हीं से बनते हैं, जब तक कोई व्यू अपनी न चुने।',
      pointValue: 'एक पॉइंट का मूल्य (₹)',
      pointValueHint: 'एक लॉयल्टी या पेंटर पॉइंट की आपकी लागत',
      save: 'सेव करें',
      saved: 'सेटिंग सेव हो गई',
      invalid: '0 से 100 % तक पैसे की लागत और ₹0 से ₹1,000 तक पॉइंट का मूल्य डालें',
    },
    headline: {
      label: 'सबसे ज़्यादा कमाई किसने कराई',
      winner: '{brand} ने सबसे ज़्यादा कमाई कराई',
      figures: '{contribution} योगदान · {margin} मार्जिन',
      none: 'इस अवधि में कोई बिक्री नहीं',
      noneHint: 'दूसरी अवधि या स्टोर चुनें।',
    },
    schemesNotCounted:
      'ब्रांड की स्कीम का पैसा अभी नहीं जोड़ा गया है: ब्रांड स्कीम सेट होते ही यह इन आंकड़ों में जुड़ जाएगा।',
    uncosted: {
      one: '{count} बिल लाइन की अभी कोई लागत नहीं थी, उसे शून्य लागत पर गिना गया।',
      other: '{count} बिल लाइनों की अभी कोई लागत नहीं थी, उन्हें शून्य लागत पर गिना गया।',
    },
    table: 'ब्रांड के हिसाब से योगदान',
    columns: {
      brand: 'ब्रांड',
      netSales: 'शुद्ध बिक्री',
      cost: 'बिक्री की लागत',
      grossMargin: 'सकल मार्जिन',
      schemes: 'स्कीम',
      creditCost: 'उधार की लागत',
      points: 'पॉइंट',
      contribution: 'योगदान',
      margin: 'मार्जिन',
    },
    total: 'सभी ब्रांड',
    noProduct: 'ब्रांड स्कीम (बिक्री नहीं)',
    explain: {
      title: 'आंकड़े कैसे निकाले जाते हैं',
      netSales: 'अवधि के बिलों का टैक्स योग्य मूल्य (GST से पहले), उन पर बने क्रेडिट नोट घटाकर।',
      cost: 'बिके हुए माल की आपकी औसत लागत (बिल के समय), शेल्फ़ पर लौटे माल की लागत घटाकर।',
      schemes:
        'ब्रांड से मिली और मिलने वाली छूट और स्कीम का पैसा, लागत के हिसाब से उसके प्रोडक्ट और स्टोर में बांटा गया।',
      creditCost:
        'इन ब्रांडों पर ग्राहकों का बकाया, अवधि में जितने दिन बकाया रहा, आपकी पैसे की लागत पर।',
      points: 'ब्रांड की बिक्री पर ग्राहकों को लॉयल्टी पॉइंट और पेंटरों को पॉइंट।',
      contribution: 'शुद्ध बिक्री − लागत + स्कीम − उधार की लागत − पॉइंट: ब्रांड से आपको क्या बचा।',
      margin: 'शुद्ध बिक्री में योगदान का हिस्सा।',
    },
    tile: {
      title: 'पिछली तिमाही का टॉप ब्रांड',
      none: 'पिछली तिमाही में कोई बिक्री नहीं',
      open: 'ब्रांड मुनाफ़ा देखें',
    },
  },
};

export const brandProfitabilityEnumsHi: Translation<typeof brandProfitabilityEnumsEn> = {
  profitabilityPeriods: {
    lastQuarter: 'पिछली तिमाही',
    thisQuarter: 'यह तिमाही',
    custom: 'तारीखें चुनें',
  },
  profitabilityGroups: {
    brand: 'सिर्फ़ ब्रांड',
    product: 'प्रोडक्ट',
    store: 'स्टोर',
  },
};
