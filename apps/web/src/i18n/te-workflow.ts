// Telugu messages shared by the stock and purchasing documents: the product picker,
// reasons and steps (draft: see docs/translations/glossary.md). Same keys as en-workflow.ts.
import type { workflowEn } from './en-workflow.js';
import type { Translation } from './shape.js';

export const workflowTe: Translation<typeof workflowEn> = {
  picker: {
    label: 'ప్రోడక్ట్ జోడించండి',
    hint: 'పేరు, బ్రాండ్ లేదా SKU టైప్ చేయండి, లేదా బార్‌కోడ్ స్కాన్ చేయండి',
    add: '{sku} జోడించండి',
    noResults: 'ప్రోడక్ట్‌లు దొరకలేదు',
    notFound: '“{code}” కోడ్‌తో ఏ ప్రోడక్ట్ లేదు',
    alreadyAdded: '{sku} ఇప్పటికే లిస్ట్‌లో ఉంది',
    inactive: '{sku} ఇప్పుడు అమ్మడం లేదు',
  },
  workflow: {
    reason: 'కారణం',
    reasonInvalid: 'కనీసం 3 అక్షరాల కారణం ఇవ్వండి',
    remove: '{sku} తొలగించండి',
    noLines: 'కనీసం ఒక ప్రోడక్ట్ జోడించండి',
    quantityInvalid: 'సున్నా కంటే ఎక్కువ క్వాంటిటీ ఇవ్వండి',
    importData: 'స్ప్రెడ్‌షీట్ నుండి ఇంపోర్ట్ చేయండి',
  },
};
