// Hindi messages for the invoice print preview (draft: see docs/translations/glossary.md).
// Same keys as en-print.ts.
import type { printEn } from './en-print.js';
import type { Translation } from './shape.js';

export const printHi: Translation<typeof printEn> = {
  print: {
    title: 'इनवॉइस प्रिंट प्रीव्यू',
    description:
      'आपके बिजनेस के नाम और लोगो के साथ एक नमूना इनवॉइस, जैसा यह A4 पेपर और 80 mm काउंटर प्रिंटर पर छपता है।',
    sampleNotice: 'नमूना डेटा। जारी किए गए इनवॉइस अपने पेज से प्रिंट होंगे।',
    print: 'प्रिंट करें',
    options: 'प्रीव्यू के विकल्प',
    format: 'पेपर',
    formats: { a4: 'A4', thermal: 'थर्मल 80 mm' },
    sample: 'नमूना',
    samples: {
      b2b: 'रजिस्टर्ड ग्राहक, उसी राज्य में',
      b2bInter: 'रजिस्टर्ड ग्राहक, दूसरे राज्य में',
      b2c: 'काउंटर ग्राहक',
      billOfSupply: 'बिल ऑफ सप्लाई (कंपोजिशन डीलर)',
    },
    secondLanguage: 'इनवॉइस पर दूसरी भाषा',
    noSecondLanguage: 'कोई नहीं',
    copy: 'कॉपी का निशान',
    copies: {
      none: 'कोई नहीं',
      original: 'ग्राहक के लिए मूल',
      duplicate: 'ट्रांसपोर्टर के लिए डुप्लीकेट',
      triplicate: 'विक्रेता के लिए ट्रिप्लीकेट',
    },
    longInvoice: 'लंबा इनवॉइस (40 लाइनें)',
    settings: {
      title: 'इनवॉइस प्रिंट',
      description: 'आपके इनवॉइस पर छपने वाले बैंक विवरण और शर्तें। लोगो दिखावट से आता है।',
      error: 'इनवॉइस प्रिंट सेटिंग्स लोड नहीं हो सकीं',
      bank: {
        title: 'बैंक विवरण',
        description:
          'A4 इनवॉइस पर छपते हैं, ताकि ग्राहक बैंक ट्रांसफर से भुगतान कर सकें। कुछ न छापने के लिए सभी खाने खाली छोड़ें।',
        bankName: 'बैंक और शाखा',
        accountName: 'खाते का नाम',
        accountNumber: 'खाता नंबर',
        ifsc: 'IFSC',
        upiId: 'UPI ID',
        upiHint: 'वैकल्पिक; बैंक विवरण के साथ छपता है',
      },
      terms: {
        title: 'नियम और शर्तें',
        label: 'शर्तें',
        hint: 'हर लाइन में एक, अधिकतम {max}, हर एक {length} अक्षर तक। हर इनवॉइस पर छपती हैं।',
      },
      save: 'सेव करें',
      saved: 'इनवॉइस प्रिंट सेटिंग्स सेव हो गईं',
      problems: {
        incomplete: 'बैंक के चारों खाने भरें, या सभी खाली छोड़ें',
        accountNumber: 'खाता नंबर डालें: 9 से 18 अंक',
        ifsc: 'SBIN0020345 जैसा IFSC डालें',
        upiId: 'shop@bank जैसी UPI ID डालें',
        upiWithoutBank: 'UPI ID छापने के लिए बैंक विवरण जोड़ें',
        tooManyTerms: 'अधिकतम {max} शर्तें',
        termTooLong: 'हर शर्त अधिकतम {length} अक्षर की हो सकती है',
      },
    },
  },
};
