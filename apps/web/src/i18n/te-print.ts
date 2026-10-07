// Telugu messages for the invoice print preview (draft: see docs/translations/glossary.md).
// Same keys as en-print.ts.
import type { printEn } from './en-print.js';
import type { Translation } from './shape.js';

export const printTe: Translation<typeof printEn> = {
  print: {
    title: 'ఇన్‌వాయిస్ ప్రింట్ ప్రివ్యూ',
    description:
      'మీ బిజినెస్ పేరు, లోగోతో ఒక నమూనా ఇన్‌వాయిస్, A4 పేపర్‌పై మరియు 80 mm కౌంటర్ ప్రింటర్‌పై ప్రింట్ అయ్యేలా.',
    sampleNotice: 'నమూనా డేటా. జారీ చేసిన ఇన్‌వాయిస్‌లు వాటి పేజీ నుండే ప్రింట్ అవుతాయి.',
    print: 'ప్రింట్ చేయండి',
    options: 'ప్రివ్యూ ఆప్షన్లు',
    format: 'పేపర్',
    formats: { a4: 'A4', thermal: 'థర్మల్ 80 mm' },
    sample: 'నమూనా',
    samples: {
      b2b: 'రిజిస్టర్డ్ కస్టమర్, అదే రాష్ట్రం',
      b2bInter: 'రిజిస్టర్డ్ కస్టమర్, వేరే రాష్ట్రం',
      b2c: 'కౌంటర్ కస్టమర్',
      billOfSupply: 'బిల్ ఆఫ్ సప్లై (కంపోజిషన్ డీలర్)',
    },
    secondLanguage: 'ఇన్‌వాయిస్‌పై రెండో భాష',
    noSecondLanguage: 'ఏదీ వద్దు',
    copy: 'కాపీ గుర్తు',
    copies: {
      none: 'ఏదీ వద్దు',
      original: 'కస్టమర్ కోసం ఒరిజినల్',
      duplicate: 'ట్రాన్స్‌పోర్టర్ కోసం డూప్లికేట్',
      triplicate: 'అమ్మకందారు కోసం ట్రిప్లికేట్',
    },
    longInvoice: 'పొడవైన ఇన్‌వాయిస్ (40 లైన్లు)',
  },
};
