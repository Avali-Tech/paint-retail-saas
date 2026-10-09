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
    settings: {
      title: 'ఇన్‌వాయిస్ ప్రింట్',
      description:
        'మీ ఇన్‌వాయిస్‌లపై ముద్రించే బ్యాంక్ వివరాలు, షరతులు. లోగో రూపురేఖల నుండి వస్తుంది.',
      error: 'ఇన్‌వాయిస్ ప్రింట్ సెట్టింగ్‌లు లోడ్ కాలేదు',
      bank: {
        title: 'బ్యాంక్ వివరాలు',
        description:
          'కస్టమర్లు బ్యాంక్ ట్రాన్స్‌ఫర్ ద్వారా చెల్లించేలా A4 ఇన్‌వాయిస్‌లపై ముద్రిస్తాం. ఏదీ ముద్రించకూడదంటే అన్నీ ఖాళీగా ఉంచండి.',
        bankName: 'బ్యాంక్, బ్రాంచ్',
        accountName: 'ఖాతా పేరు',
        accountNumber: 'ఖాతా నంబర్',
        ifsc: 'IFSC',
        upiId: 'UPI ID',
        upiHint: 'ఐచ్ఛికం; బ్యాంక్ వివరాలతో ముద్రిస్తాం',
      },
      terms: {
        title: 'నిబంధనలు, షరతులు',
        label: 'షరతులు',
        hint: 'ఒక్కో లైన్‌లో ఒకటి, గరిష్ఠంగా {max}, ఒక్కొక్కటి {length} అక్షరాల వరకు. ప్రతి ఇన్‌వాయిస్‌పై ముద్రిస్తాం.',
      },
      save: 'సేవ్ చేయండి',
      saved: 'ఇన్‌వాయిస్ ప్రింట్ సెట్టింగ్‌లు సేవ్ అయ్యాయి',
      problems: {
        incomplete: 'బ్యాంక్ నాలుగు వివరాలూ నింపండి, లేదా అన్నీ ఖాళీగా ఉంచండి',
        accountNumber: 'ఖాతా నంబర్ ఇవ్వండి: 9 నుండి 18 అంకెలు',
        ifsc: 'SBIN0020345 లాంటి IFSC ఇవ్వండి',
        upiId: 'shop@bank లాంటి UPI ID ఇవ్వండి',
        upiWithoutBank: 'UPI ID ముద్రించడానికి బ్యాంక్ వివరాలు జోడించండి',
        tooManyTerms: 'గరిష్ఠంగా {max} షరతులు',
        termTooLong: 'ఒక్కో షరతు గరిష్ఠంగా {length} అక్షరాలు',
      },
    },
  },
};
