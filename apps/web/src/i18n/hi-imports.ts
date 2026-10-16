// Hindi messages for importing products, parties and opening stock from a spreadsheet
// (draft: see docs/translations/glossary.md). Same keys as en-imports.ts.
import type { importsEn } from './en-imports.js';
import type { Translation } from './shape.js';

export const importsHi: Translation<typeof importsEn> = {
  imports: {
    title: 'डेटा इम्पोर्ट करें',
    description:
      'Excel या Google Sheets से एक साथ कई रिकॉर्ड जोड़ें या अपडेट करें। इम्पोर्ट करने तक कुछ भी सेव नहीं होता।',
    error: 'इम्पोर्ट के प्रकार लोड नहीं हो सके',
    noKinds: 'आपके रोल से कुछ भी इम्पोर्ट नहीं हो सकता',
    noKindsDescription: 'प्रोडक्ट, ग्राहक या स्टॉक संभालने की अनुमति के लिए अपने मालिक से कहें।',
    kindLegend: 'क्या इम्पोर्ट करना है',
    kinds: {
      products: 'प्रोडक्ट और पैक साइज',
      parties: 'ग्राहक, सप्लायर और दूसरी पार्टियां',
      'opening-stock': 'हर स्टोर का ओपनिंग स्टॉक',
      'opening-balances': 'बिलिंग शुरू होने पर ओपनिंग बैलेंस',
    },
    columns: 'कॉलम',
    columnsList: '{kind} के कॉलम',
    column: 'कॉलम',
    required: 'जरूरी',
    optional: 'जरूरी नहीं',
    meaning: 'क्या डालना है',
    example: 'उदाहरण',
    template: 'टेम्पलेट डाउनलोड करें',
    templateHint: 'इन कॉलम और एक उदाहरण लाइन वाली CSV; इसे भरें और सेव करें।',
    file: {
      label: 'स्प्रेडशीट',
      hint: 'CSV या Excel (.xlsx), पहली शीट, ज्यादा से ज्यादा 5,000 लाइनें',
      reading: '{name} जांच रहे हैं…',
      notSpreadsheet: 'यह फाइल स्प्रेडशीट की तरह पढ़ी नहीं जा सकती। इसे CSV या .xlsx में सेव करें।',
      unsupported:
        'यह वर्कबुक पासवर्ड से सुरक्षित है या ऐसे सेव है कि हम पढ़ नहीं सकते। इसे CSV में सेव करें।',
      empty: 'पहली शीट खाली है।',
      tooLarge: 'यह फाइल बहुत बड़ी है। एक बार में ज्यादा से ज्यादा 5,000 लाइनें इम्पोर्ट करें।',
      oldFormat:
        'पुरानी Excel (.xls) और दूसरे फॉर्मेट पढ़े नहीं जा सकते। इसे CSV या .xlsx में सेव करें।',
    },
    preview: {
      title: 'जांचें',
      totals: 'यह फाइल क्या करेगी',
      rows: 'लाइनें',
      create: 'जोड़ने के लिए',
      update: 'अपडेट के लिए',
      unchanged: 'कोई बदलाव नहीं',
      errors: 'गलतियां',
      valid: '{name} इम्पोर्ट के लिए तैयार है: अभी कुछ भी सेव नहीं हुआ है।',
      invalid: '{name} में समस्याएं: {count}। इन्हें स्प्रेडशीट में ठीक करें और फाइल फिर से चुनें।',
      errorList: 'लाइन के हिसाब से समस्याएं',
      row: 'लाइन',
      column: 'कॉलम',
      problem: 'समस्या',
      wholeRow: 'पूरी लाइन',
      planList: 'इस फाइल की लाइनें',
      record: 'रिकॉर्ड',
      action: 'एक्शन',
      capped: '{total} में से पहली {shown} दिखा रहे हैं।',
    },
    actions: { create: 'जोड़ें', update: 'अपडेट', unchanged: 'कोई बदलाव नहीं' },
    commit: { one: '{count} लाइन इम्पोर्ट करें', other: '{count} लाइनें इम्पोर्ट करें' },
    committed: 'इम्पोर्ट हुआ: {create} जोड़े, {update} अपडेट हुए, {unchanged} में बदलाव नहीं।',
    toast: 'इम्पोर्ट पूरा हुआ',
    notSaved: 'कुछ भी इम्पोर्ट नहीं हुआ। गलती वाली लाइनें ठीक करें और फिर कोशिश करें।',
    another: 'दूसरी फाइल इम्पोर्ट करें',
    next: {
      products: 'प्रोडक्ट खोलें',
      parties: 'ग्राहक खोलें',
      'opening-stock': 'स्टॉक खोलें',
      'opening-balances': 'बिलिंग गो-लाइव देखें',
    },
  },
};
