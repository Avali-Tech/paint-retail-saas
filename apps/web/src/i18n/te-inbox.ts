// Telugu messages for the "Needs action" inbox (draft: see docs/translations/glossary.md).
// Same keys as en-inbox.ts.
import type { inboxEn, inboxEnumsEn } from './en-inbox.js';
import type { Translation } from './shape.js';

export const inboxTe: Translation<typeof inboxEn> = {
  inbox: {
    nav: 'ఇన్‌బాక్స్',
    title: 'మీ పనులు',
    description:
      'మీ కోసం ఎదురుచూస్తున్నవన్నీ: అనుమతులు, పంపాల్సిన లేదా రిసీవ్ చేయాల్సిన స్టాక్, లెక్కింపులు, తప్పిన హామీలు, ఫాలో-అప్‌లు, తక్కువ స్టాక్',
    waiting: '{count} మీ కోసం ఎదురుచూస్తున్నాయి',
    kind: 'చూపించు',
    allKinds: 'అన్నీ',
    store: 'స్టోర్',
    allStores: 'అన్ని స్టోర్లు',
    error: 'మీ ఇన్‌బాక్స్ లోడ్ కాలేదు',
    empty: 'మీ కోసం ఏమీ పెండింగ్ లేదు',
    emptyDescription:
      'మీరు చూడాల్సిన అనుమతులు, ట్రాన్స్‌ఫర్లు, లెక్కింపులు, ఫాలో-అప్‌లు ఇక్కడ కనిపిస్తాయి.',
    urgent: 'అత్యవసరం',
    by: '{name} అడిగారు',
    since: '{when} వచ్చింది',
    due: '{when} లోపు',
    quantity: '{available} {unit} అందుబాటులో, {level} వద్ద రీఆర్డర్',
    seeAll: 'అన్నీ {count} చూడండి',
    approve: 'ఆమోదించండి',
    reject: 'తిరస్కరించండి',
    approveTransfer: 'ట్రాన్స్‌ఫర్ {number} ఆమోదించండి',
    rejectTransfer: 'ట్రాన్స్‌ఫర్ {number} తిరస్కరించండి',
    acknowledge: 'చూశాను',
    acknowledgeName: '{name} తప్పిన హామీని చూశాను',
    done: 'పూర్తయింది',
    doneName: '“{name}” పూర్తయింది',
    open: {
      dispatch: 'డిస్పాచ్ చేయండి',
      receive: 'రిసీవ్ చేయండి',
      review: 'పరిశీలించండి',
      reorder: 'రీఆర్డర్ చేయండి',
    },
  },
};

export const inboxEnumsTe: Translation<typeof inboxEnumsEn> = {
  inboxKinds: {
    credit_approval: 'క్రెడిట్ అనుమతులు',
    credit_request: 'క్రెడిట్ అభ్యర్థనలు',
    transfer: 'ట్రాన్స్‌ఫర్లు',
    stock_count: 'స్టాక్ లెక్కింపులు',
    escalation: 'తప్పిన హామీలు',
    follow_up: 'ఫాలో-అప్‌లు',
    low_stock: 'తక్కువ స్టాక్',
  },
  inboxSteps: {
    approve_sale: 'అరువు అమ్మకానికి అనుమతి',
    approve_release: 'క్రెడిట్ హోల్డ్ తీసివేయాలి',
    decide_request: 'క్రెడిట్ లిమిట్ నిర్ణయం',
    approve_transfer: 'ఆమోదించాలి',
    dispatch_transfer: 'డిస్పాచ్ చేయాలి',
    receive_transfer: 'రిసీవ్ చేయాలి',
    approve_count: 'లెక్కింపు ఆమోదించాలి',
    acknowledge_escalation: 'హామీ తప్పింది',
    follow_up_overdue: 'గడువు దాటింది',
    follow_up_today: 'ఈరోజు',
    out_of_stock: 'స్టాక్ అయిపోయింది',
    below_minimum: 'కనీసం కంటే తక్కువ',
    reorder: 'రీఆర్డర్ సమయం',
  },
};
