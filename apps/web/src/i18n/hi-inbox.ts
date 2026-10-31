// Hindi messages for the "Needs action" inbox (draft: see docs/translations/glossary.md).
// Same keys as en-inbox.ts.
import type { inboxEn, inboxEnumsEn } from './en-inbox.js';
import type { Translation } from './shape.js';

export const inboxHi: Translation<typeof inboxEn> = {
  inbox: {
    nav: 'इनबॉक्स',
    title: 'आपके काम',
    description:
      'जो कुछ आपका इंतजार कर रहा है: मंजूरी, भेजने या रिसीव करने का स्टॉक, गिनती, टूटे वादे, फॉलो-अप और कम स्टॉक',
    waiting: '{count} आपके इंतजार में',
    kind: 'दिखाएं',
    allKinds: 'सब कुछ',
    store: 'स्टोर',
    allStores: 'सभी स्टोर',
    error: 'आपका इनबॉक्स लोड नहीं हो सका',
    empty: 'आपके लिए कुछ बाकी नहीं है',
    emptyDescription: 'जिन मंजूरी, ट्रांसफर, गिनती और फॉलो-अप को आपकी जरूरत है, वे यहां दिखेंगे।',
    urgent: 'जरूरी',
    by: '{name} द्वारा',
    since: '{when} आया',
    due: '{when} तक',
    quantity: '{available} {unit} उपलब्ध, {level} पर रीऑर्डर',
    seeAll: 'सभी {count} देखें',
    approve: 'मंजूर करें',
    reject: 'नामंजूर करें',
    approveTransfer: 'ट्रांसफर {number} मंजूर करें',
    rejectTransfer: 'ट्रांसफर {number} नामंजूर करें',
    acknowledge: 'देख लिया',
    acknowledgeName: '{name} का टूटा वादा देख लिया',
    done: 'हो गया',
    doneName: '“{name}” हो गया',
    open: {
      dispatch: 'डिस्पैच करें',
      receive: 'रिसीव करें',
      review: 'जांचें',
      reorder: 'रीऑर्डर करें',
    },
  },
};

export const inboxEnumsHi: Translation<typeof inboxEnumsEn> = {
  inboxKinds: {
    credit_approval: 'क्रेडिट मंजूरी',
    credit_request: 'क्रेडिट अनुरोध',
    transfer: 'ट्रांसफर',
    stock_count: 'स्टॉक गिनती',
    escalation: 'टूटे वादे',
    follow_up: 'फॉलो-अप',
    low_stock: 'कम स्टॉक',
  },
  inboxSteps: {
    approve_sale: 'उधार बिक्री की मंजूरी',
    approve_release: 'क्रेडिट होल्ड हटाना',
    decide_request: 'क्रेडिट लिमिट का फैसला',
    approve_transfer: 'मंजूरी बाकी',
    dispatch_transfer: 'डिस्पैच बाकी',
    receive_transfer: 'रिसीव बाकी',
    approve_count: 'गिनती की मंजूरी',
    acknowledge_escalation: 'वादा टूटा',
    follow_up_overdue: 'समय निकल गया',
    follow_up_today: 'आज करना है',
    out_of_stock: 'स्टॉक खत्म',
    below_minimum: 'न्यूनतम से कम',
    reorder: 'रीऑर्डर का समय',
  },
};
