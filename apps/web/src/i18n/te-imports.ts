// Telugu messages for importing products, parties and opening stock from a spreadsheet
// (draft: see docs/translations/glossary.md). Same keys as en-imports.ts.
import type { importsEn } from './en-imports.js';
import type { Translation } from './shape.js';

export const importsTe: Translation<typeof importsEn> = {
  imports: {
    title: 'డేటా ఇంపోర్ట్ చేయండి',
    description:
      'Excel లేదా Google Sheets నుండి ఒకేసారి చాలా రికార్డులు జోడించండి లేదా అప్‌డేట్ చేయండి. ఇంపోర్ట్ చేసే వరకు ఏదీ సేవ్ కాదు.',
    error: 'ఇంపోర్ట్ రకాలు లోడ్ కాలేదు',
    noKinds: 'మీ రోల్‌తో ఏదీ ఇంపోర్ట్ చేయలేరు',
    noKindsDescription:
      'ప్రోడక్ట్‌లు, కస్టమర్లు లేదా స్టాక్ నిర్వహించే అనుమతి కోసం మీ యజమానిని అడగండి.',
    kindLegend: 'ఏమి ఇంపోర్ట్ చేయాలి',
    kinds: {
      products: 'ప్రోడక్ట్‌లు, ప్యాక్ సైజ్‌లు',
      parties: 'కస్టమర్లు, సప్లయర్లు, ఇతర పార్టీలు',
      'opening-stock': 'ప్రతి స్టోర్ ఓపెనింగ్ స్టాక్',
    },
    columns: 'కాలమ్‌లు',
    columnsList: '{kind} కాలమ్‌లు',
    column: 'కాలమ్',
    required: 'తప్పనిసరి',
    optional: 'ఐచ్ఛికం',
    meaning: 'ఏమి ఇవ్వాలి',
    example: 'ఉదాహరణ',
    template: 'టెంప్లేట్ డౌన్‌లోడ్ చేయండి',
    templateHint: 'ఈ కాలమ్‌లు, ఒక ఉదాహరణ వరుస ఉన్న CSV; దాన్ని నింపి సేవ్ చేయండి.',
    file: {
      label: 'స్ప్రెడ్‌షీట్',
      hint: 'CSV లేదా Excel (.xlsx), మొదటి షీట్, గరిష్ఠంగా 5,000 వరుసలు',
      reading: '{name} చెక్ చేస్తున్నాం…',
      notSpreadsheet: 'ఈ ఫైల్‌ను స్ప్రెడ్‌షీట్‌గా చదవలేము. దాన్ని CSV లేదా .xlsx గా సేవ్ చేయండి.',
      unsupported:
        'ఈ వర్క్‌బుక్‌కు పాస్‌వర్డ్ ఉంది లేదా మేము చదవలేని విధంగా సేవ్ చేశారు. దాన్ని CSV గా సేవ్ చేయండి.',
      empty: 'మొదటి షీట్ ఖాళీగా ఉంది.',
      tooLarge: 'ఈ ఫైల్ చాలా పెద్దది. ఒకేసారి గరిష్ఠంగా 5,000 వరుసలు ఇంపోర్ట్ చేయండి.',
      oldFormat: 'పాత Excel (.xls), ఇతర ఫార్మాట్లు చదవలేము. దాన్ని CSV లేదా .xlsx గా సేవ్ చేయండి.',
    },
    preview: {
      title: 'చెక్ చేయండి',
      totals: 'ఈ ఫైల్ ఏమి చేస్తుంది',
      rows: 'వరుసలు',
      create: 'జోడించాల్సినవి',
      update: 'అప్‌డేట్ చేయాల్సినవి',
      unchanged: 'మార్పు లేనివి',
      errors: 'తప్పులు',
      valid: '{name} ఇంపోర్ట్‌కు సిద్ధంగా ఉంది: ఇంకా ఏదీ సేవ్ కాలేదు.',
      invalid:
        '{name} లో సమస్యలు: {count}. వాటిని స్ప్రెడ్‌షీట్‌లో సరిచేసి ఫైల్‌ను మళ్లీ ఎంచుకోండి.',
      errorList: 'వరుస వారీగా సమస్యలు',
      row: 'వరుస',
      column: 'కాలమ్',
      problem: 'సమస్య',
      wholeRow: 'మొత్తం వరుస',
      planList: 'ఈ ఫైల్‌లోని వరుసలు',
      record: 'రికార్డ్',
      action: 'చర్య',
      capped: '{total} లో మొదటి {shown} చూపిస్తున్నాం.',
    },
    actions: { create: 'జోడించు', update: 'అప్‌డేట్', unchanged: 'మార్పు లేదు' },
    commit: { one: '{count} వరుస ఇంపోర్ట్ చేయండి', other: '{count} వరుసలు ఇంపోర్ట్ చేయండి' },
    committed:
      'ఇంపోర్ట్ అయింది: {create} జోడించారు, {update} అప్‌డేట్ చేశారు, {unchanged} మార్పు లేదు.',
    toast: 'ఇంపోర్ట్ పూర్తయింది',
    notSaved: 'ఏదీ ఇంపోర్ట్ కాలేదు. తప్పులు ఉన్న వరుసలు సరిచేసి మళ్లీ ప్రయత్నించండి.',
    another: 'మరో ఫైల్ ఇంపోర్ట్ చేయండి',
    next: {
      products: 'ప్రోడక్ట్‌లు తెరవండి',
      parties: 'కస్టమర్లను తెరవండి',
      'opening-stock': 'స్టాక్ తెరవండి',
    },
  },
};
