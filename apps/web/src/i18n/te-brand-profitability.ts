// Telugu messages for brand profitability (draft: see docs/translations/glossary.md).
// Same keys as en-brand-profitability.ts.
import type { brandProfitabilityEn, brandProfitabilityEnumsEn } from './en-brand-profitability.js';
import type { Translation } from './shape.js';

export const brandProfitabilityTe: Translation<typeof brandProfitabilityEn> = {
  brandProfitability: {
    nav: 'బ్రాండ్ లాభం',
    title: 'బ్రాండ్ లాభం',
    description: 'ఖర్చు, అప్పు, పాయింట్ల తర్వాత ప్రతి బ్రాండ్ మీకు నిజంగా ఎంత సంపాదించింది.',
    error: 'బ్రాండ్ లాభం లోడ్ కాలేదు',
    filters: 'ఫిల్టర్లు',
    period: 'కాలం',
    from: 'నుండి',
    to: 'వరకు',
    allStores: 'నా అన్ని స్టోర్లు',
    splitBy: 'దీని ప్రకారం విభజించండి',
    costOfMoney: 'డబ్బు ఖర్చు (% సంవత్సరానికి)',
    costOfMoneyHint: 'కస్టమర్ల దగ్గర ఉన్న డబ్బుకు మీకయ్యే ఖర్చు; ఖాళీగా ఉంటే మీ సెట్టింగ్',
    brandFilter: 'బ్రాండ్: {name}',
    allBrands: 'అన్ని బ్రాండ్లు చూపించండి',
    split: '{name}ను ప్రోడక్ట్ ప్రకారం విభజించండి',
    csv: 'CSV డౌన్‌లోడ్ చేయండి',
    csvFailed: 'రిపోర్ట్ డౌన్‌లోడ్ కాలేదు',
    periodRange: '{from} నుండి {to} వరకు',
    settings: {
      open: 'సెట్టింగ్‌లు',
      title: 'లాభం సెట్టింగ్‌లు',
      description: 'బ్రాండ్ లాభం లెక్కలన్నీ వీటినే వాడతాయి, ఏదైనా వ్యూ తనదే ఎంచుకుంటే తప్ప.',
      pointValue: 'ఒక పాయింట్ విలువ (₹)',
      pointValueHint: 'ఒక లాయల్టీ లేదా పెయింటర్ పాయింట్‌కు మీకయ్యే ఖర్చు',
      save: 'సేవ్ చేయండి',
      saved: 'సెట్టింగ్‌లు సేవ్ అయ్యాయి',
      invalid: '0 నుండి 100 % వరకు డబ్బు ఖర్చు, ₹0 నుండి ₹1,000 వరకు పాయింట్ విలువ ఇవ్వండి',
    },
    headline: {
      label: 'ఎక్కువ డబ్బు ఎవరు సంపాదించారు',
      winner: '{brand} ఎక్కువ డబ్బు సంపాదించింది',
      figures: '{contribution} కంట్రిబ్యూషన్ · {margin} మార్జిన్',
      none: 'ఈ కాలంలో అమ్మకాలు లేవు',
      noneHint: 'వేరే కాలం లేదా స్టోర్ ఎంచుకోండి.',
    },
    schemesNotCounted:
      'బ్రాండ్ స్కీమ్ డబ్బు ఇంకా లెక్కించలేదు: బ్రాండ్ స్కీమ్‌లు సెట్ చేశాక ఇది ఈ లెక్కల్లో కలుస్తుంది.',
    uncosted: {
      one: '{count} బిల్ లైన్‌కు ఇంకా ఖర్చు ధర లేదు, సున్నా ఖర్చుగా లెక్కించాం.',
      other: '{count} బిల్ లైన్లకు ఇంకా ఖర్చు ధర లేదు, సున్నా ఖర్చుగా లెక్కించాం.',
    },
    table: 'బ్రాండ్ వారీగా కంట్రిబ్యూషన్',
    columns: {
      brand: 'బ్రాండ్',
      netSales: 'నికర అమ్మకాలు',
      cost: 'అమ్మకాల ఖర్చు',
      grossMargin: 'స్థూల మార్జిన్',
      schemes: 'స్కీమ్‌లు',
      creditCost: 'అప్పు ఖర్చు',
      points: 'పాయింట్లు',
      contribution: 'కంట్రిబ్యూషన్',
      margin: 'మార్జిన్',
    },
    total: 'అన్ని బ్రాండ్లు',
    noProduct: 'బ్రాండ్ స్కీమ్‌లు (అమ్మకాలు లేవు)',
    explain: {
      title: 'లెక్కలు ఎలా వేస్తాం',
      netSales: 'ఈ కాలం బిల్లుల పన్ను విధించదగిన విలువ (GST ముందు), వాటిపై క్రెడిట్ నోట్లు తీసేసి.',
      cost: 'అమ్మిన యూనిట్లకు బిల్ సమయంలో మీ సగటు ఖర్చు, షెల్ఫ్‌కు తిరిగి వచ్చిన యూనిట్లు తీసేసి.',
      schemes:
        'బ్రాండ్ నుండి వచ్చిన, ఇంకా రావలసిన రిబేట్లు, స్కీమ్ డబ్బు, ఖర్చు ప్రకారం దాని ప్రోడక్ట్‌లు, స్టోర్లకు పంచి.',
      creditCost:
        'ఈ బ్రాండ్లపై కస్టమర్ల బాకీ, ఈ కాలంలో చెల్లించని ప్రతి రోజుకు, మీ డబ్బు ఖర్చు రేటుతో.',
      points: 'బ్రాండ్ అమ్మకాలపై కస్టమర్లకు లాయల్టీ పాయింట్లు, పెయింటర్లకు పాయింట్లు.',
      contribution:
        'నికర అమ్మకాలు − ఖర్చు + స్కీమ్‌లు − అప్పు ఖర్చు − పాయింట్లు: బ్రాండ్ మీకు మిగిల్చింది.',
      margin: 'నికర అమ్మకాల్లో కంట్రిబ్యూషన్ వాటా.',
    },
    tile: {
      title: 'గత త్రైమాసికం టాప్ బ్రాండ్',
      none: 'గత త్రైమాసికంలో అమ్మకాలు లేవు',
      open: 'బ్రాండ్ లాభం చూడండి',
    },
  },
};

export const brandProfitabilityEnumsTe: Translation<typeof brandProfitabilityEnumsEn> = {
  profitabilityPeriods: {
    lastQuarter: 'గత త్రైమాసికం',
    thisQuarter: 'ఈ త్రైమాసికం',
    custom: 'తేదీలు ఎంచుకోండి',
  },
  profitabilityGroups: {
    brand: 'బ్రాండ్ మాత్రమే',
    product: 'ప్రోడక్ట్',
    store: 'స్టోర్',
  },
};
