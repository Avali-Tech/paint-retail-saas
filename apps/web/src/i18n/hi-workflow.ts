// Hindi messages shared by the stock and purchasing documents: the product picker,
// reasons and steps (draft: see docs/translations/glossary.md). Same keys as en-workflow.ts.
import type { workflowEn } from './en-workflow.js';
import type { Translation } from './shape.js';

export const workflowHi: Translation<typeof workflowEn> = {
  picker: {
    label: 'प्रोडक्ट जोड़ें',
    hint: 'नाम, ब्रांड या SKU टाइप करें, या बारकोड स्कैन करें',
    add: '{sku} जोड़ें',
    noResults: 'कोई प्रोडक्ट नहीं मिला',
    notFound: '“{code}” कोड वाला कोई प्रोडक्ट नहीं है',
    alreadyAdded: '{sku} पहले से लिस्ट में है',
    inactive: '{sku} अब नहीं बिकता',
  },
  workflow: {
    reason: 'कारण',
    reasonInvalid: 'कम से कम 3 अक्षर का कारण लिखें',
    remove: '{sku} हटाएं',
    noLines: 'कम से कम एक प्रोडक्ट जोड़ें',
    quantityInvalid: 'शून्य से ज्यादा मात्रा डालें',
    importData: 'स्प्रेडशीट से इम्पोर्ट करें',
  },
};
