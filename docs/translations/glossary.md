# Hindi and Telugu: glossary and review guide

> **Status: draft translations.** Every Hindi (`hi`) and Telugu (`te`) message in the web app
> was drafted without a native-speaker review. They are meant to be correct and natural, but a
> native speaker who knows how paint-shop staff talk should check them before they are offered to
> customers.

## Style

- **Everyday shop language, not formal or textbook language.** The reader is counter staff and
  owners in a paint shop. Short, plain sentences.
- **Address the user politely:** Hindi with _आप_ and the _-ें_ imperative (करें, चुनें, डालें);
  Telugu with _మీరు_ and the _-ండి_ imperative (చేయండి, ఎంచుకోండి).
- **English trade and tech words stay** where staff really use them. Words are written in the
  local script (स्टॉक, స్టాక్); **abbreviations stay in Latin letters** (GST, GSTIN, OTP, SKU, MRP,
  PO, GRN, HSN, PDF, QR, CSV, WCAG, KB, MB). Brand and product names are never translated.
- **Hindi spelling:** no nukta (फॉलो-अप, जरूरी), sentences end with the purna viram "।".
  **Telugu** sentences end with ".".
- **Numbers and dates** keep the Indian format in every language: Latin digits, lakh/crore
  grouping (12,34,567), ₹, compact "L" and "Cr", India time. Month names follow the language.
- **Placeholders** such as `{count}`, `{name}`, `{sku}` are kept exactly; only their position in
  the sentence moves. A test fails if one is missing or misspelt.
- **Counts** use `{ one, other }` messages. Hindi's "one" form is used for 0 and 1; Telugu's and
  English's for 1 only.
- Punctuation from the English (`…`, `–`, `·`, “ ”) is kept.

## Glossary

| English                             | Hindi (hi)                               | Telugu (te)                                        | Note                                                                         |
| ----------------------------------- | ---------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| Sign in / Sign out                  | लॉगिन करें / लॉगआउट                      | లాగిన్ చేయండి / లాగౌట్                             | "login" is what staff say                                                    |
| Password                            | पासवर्ड                                  | పాస్‌వర్డ్                                         |                                                                              |
| Mobile number                       | मोबाइल नंबर                              | మొబైల్ నంబర్                                       |                                                                              |
| Code (texted, 6-digit)              | कोड, OTP                                 | కోడ్, OTP                                          |                                                                              |
| Two-factor sign-in                  | टू-फैक्टर लॉगिन                          | టూ-ఫ్యాక్టర్ లాగిన్                                |                                                                              |
| Authenticator app                   | ऑथेंटिकेटर ऐप                            | ఆథెంటికేటర్ యాప్                                   |                                                                              |
| Recovery code                       | रिकवरी कोड                               | రికవరీ కోడ్                                        |                                                                              |
| Business                            | बिजनेस                                   | బిజినెస్                                           | the whole company (tenant)                                                   |
| Store (one branch)                  | स्टोर                                    | స్టోర్                                             |                                                                              |
| Owner / admin                       | मालिक / एडमिन                            | యజమాని / అడ్మిన్                                   |                                                                              |
| Team member / role / permission     | टीम मेंबर / रोल / अनुमति                 | టీమ్ మెంబర్ / రోల్ / అనుమతి                        |                                                                              |
| Customer                            | ग्राहक                                   | కస్టమర్                                            |                                                                              |
| Party (any customer/supplier)       | पार्टी                                   | పార్టీ                                             | the trade's own word                                                         |
| Contractor / painter / architect    | कॉन्ट्रैक्टर / पेंटर / आर्किटेक्ट        | కాంట్రాక్టర్ / పెయింటర్ / ఆర్కిటెక్ట్              |                                                                              |
| Dealer / sub-dealer / distributor   | डीलर / सब-डीलर / डिस्ट्रीब्यूटर          | డీలర్ / సబ్-డీలర్ / డిస్ట్రిబ్యూటర్                |                                                                              |
| Supplier                            | सप्लायर                                  | సప్లయర్                                            |                                                                              |
| Product / pack size / brand         | प्रोडक्ट / पैक साइज / ब्रांड             | ప్రోడక్ట్ / ప్యాక్ సైజ్ / బ్రాండ్                  |                                                                              |
| Category / shade                    | कैटेगरी / शेड                            | కేటగిరీ / షేడ్                                     |                                                                              |
| Primer / putty / enamel / emulsion  | प्राइमर / पुट्टी / इनेमल / इमल्शन        | ప్రైమర్ / పుట్టీ / ఎనామెల్ / ఎమల్షన్               |                                                                              |
| Price / MRP / cost                  | कीमत / MRP / लागत                        | ధర / MRP / ఖర్చు ధర                                | cost = what the shop paid                                                    |
| GST / GSTIN / HSN                   | GST / GSTIN / HSN                        | GST / GSTIN / HSN                                  | always Latin                                                                 |
| Stock / low stock / out of stock    | स्टॉक / कम स्टॉक / स्टॉक खत्म            | స్టాక్ / తక్కువ స్టాక్ / స్టాక్ అయిపోయింది         |                                                                              |
| Reorder level                       | रीऑर्डर लेवल                             | రీఆర్డర్ లెవెల్                                    |                                                                              |
| Stock count                         | स्टॉक गिनती                              | స్టాక్ లెక్కింపు                                   |                                                                              |
| Adjustment                          | एडजस्टमेंट                               | సర్దుబాటు                                          |                                                                              |
| Transfer / dispatch / receive       | ट्रांसफर / डिस्पैच / रिसीव               | ట్రాన్స్‌ఫర్ / డిస్పాచ్ / రిసీవ్                   |                                                                              |
| Quantity / units                    | मात्रा / यूनिट                           | క్వాంటిటీ / యూనిట్లు                               |                                                                              |
| SKU / barcode / scan                | SKU / बारकोड / स्कैन                     | SKU / బార్‌కోడ్ / స్కాన్                           |                                                                              |
| Purchase order (PO)                 | परचेज ऑर्डर (PO)                         | పర్చేస్ ఆర్డర్ (PO)                                |                                                                              |
| Goods receipt (GRN)                 | माल की रसीद (GRN)                        | సరుకు రసీదు (GRN)                                  |                                                                              |
| Invoice / bill / challan            | इनवॉइस / बिल / चालान                     | ఇన్‌వాయిస్ / బిల్ / చలాన్                          |                                                                              |
| Credit / credit limit / credit days | क्रेडिट / क्रेडिट लिमिट / क्रेडिट के दिन | క్రెడిట్ / క్రెడిట్ లిమిట్ / క్రెడిట్ రోజులు       |                                                                              |
| On hold                             | होल्ड पर                                 | హోల్డ్‌లో                                          |                                                                              |
| Outstanding (money owed)            | बकाया                                    | బకాయి                                              |                                                                              |
| Overdue (a task)                    | समय निकल गया                             | గడువు దాటింది                                      |                                                                              |
| Loyalty points / tier / redeem      | लॉयल्टी पॉइंट / टियर / रिडीम             | లాయల్టీ పాయింట్లు / టియర్ / రిడీమ్                 |                                                                              |
| Lead / opportunity / pipeline       | लीड / ऑपर्च्युनिटी / पाइपलाइन            | లీడ్ / ఆపర్చునిటీ / పైప్‌లైన్                      | CRM words kept                                                               |
| Project / site                      | प्रोजेक्ट / साइट                         | ప్రాజెక్ట్ / సైట్                                  |                                                                              |
| Follow-up / activity                | फॉलो-अप / एक्टिविटी                      | ఫాలో-అప్ / యాక్టివిటీ                              | call, visit, note: कॉल, विजिट, नोट / కాల్, విజిట్, నోట్                      |
| Contract / renew                    | कॉन्ट्रैक्ट / रिन्यू                     | కాంట్రాక్ట్ / రెన్యూ                               |                                                                              |
| Document / upload / download        | डॉक्यूमेंट / अपलोड / डाउनलोड             | డాక్యుమెంట్ / అప్‌లోడ్ / డౌన్‌లోడ్                 |                                                                              |
| Report / import / spreadsheet       | रिपोर्ट / इम्पोर्ट / स्प्रेडशीट          | రిపోర్ట్ / ఇంపోర్ట్ / స్ప్రెడ్‌షీట్                |                                                                              |
| Dashboard / notifications           | डैशबोर्ड / नोटिफिकेशन                    | డాష్‌బోర్డ్ / నోటిఫికేషన్లు                        |                                                                              |
| Search                              | खोजें                                    | వెతకండి                                            |                                                                              |
| Save / cancel / edit / delete       | सेव करें / रद्द करें / बदलें / हटाएं     | సేవ్ చేయండి / రద్దు చేయండి / మార్చండి / తొలగించండి |                                                                              |
| Approve / reject                    | मंजूर करें / नामंजूर करें                | ఆమోదించండి / తిరస్కరించండి                         |                                                                              |
| Draft                               | ड्राफ्ट                                  | డ్రాఫ్ట్                                           |                                                                              |
| Active / inactive                   | एक्टिव / इनएक्टिव                        | యాక్టివ్ / ఇనాక్టివ్                               |                                                                              |
| On / off                            | चालू / बंद                               | ఆన్ / ఆఫ్                                          |                                                                              |
| Appearance                          | दिखावट                                   | రూపురేఖలు                                          | the theme screen                                                             |
| Audit log                           | ऑडिट लॉग                                 | ఆడిట్ లాగ్                                         |                                                                              |
| Day(s)                              | दिन                                      | రోజు / రోజులు                                      |                                                                              |
| Language                            | भाषा                                     | భాష                                                | names: English, हिन्दी, తెలుగు, never translated                             |
| Account security                    | अकाउंट सुरक्षा                           | అకౌంట్ భద్రత                                       | the settings screen; Language is on it                                       |
| Status                              | स्टेटस                                   | స్టేటస్                                            |                                                                              |
| Stage / source                      | स्टेज / सोर्स                            | స్టేజ్ / సోర్స్                                    | pipeline words                                                               |
| Value (money)                       | वैल्यू, मूल्य                            | విలువ                                              | Hindi: वैल्यू in CRM/dashboard, मूल्य for stock value; reviewer may pick one |
| Optional                            | जरूरी नहीं                               | ఐచ్ఛికం                                            | Telugu ఐచ్ఛికం is bookish; అవసరమైతే is an option                             |
| Request (noun / verb)               | रिक्वेस्ट / मांगें                       | రిక్వెస్ట్ / అడగండి                                |                                                                              |
| Opening stock / godown              | ओपनिंग स्टॉक / गोदाम                     | ఓపెనింగ్ స్టాక్ / గోడౌన్                           |                                                                              |
| Write off / movement                | राइट-ऑफ / मूवमेंट                        | రైట్-ఆఫ్ / మూవ్‌మెంట్                              |                                                                              |
| Minimum / maximum                   | न्यूनतम / अधिकतम                         | కనిష్ఠం / గరిష్ఠం                                  |                                                                              |
| Payment terms / cash                | पेमेंट की शर्तें / नकद                   | పేమెంట్ షరతులు / క్యాష్                            |                                                                              |
| Late payment (overdue)              | देरी                                     | ఆలస్యం                                             | for money; tasks use समय निकल गया / గడువు దాటింది                            |
| Sale on credit                      | उधार                                     | క్రెడిట్                                           | Hindi shop word                                                              |
| Balance (owed / points)             | बकाया / बैलेंस                           | బకాయి / బ్యాలెన్స్                                 |                                                                              |
| Salesperson                         | सेल्समैन                                 | సేల్స్‌మన్                                         |                                                                              |
| Assign / log / schedule             | सौंपें / दर्ज करें / तय करें             | అప్పగించండి / నమోదు చేయండి / పెట్టండి              | follow-ups and activities                                                    |
| Won / lost                          | जीता / हारा                              | గెలిచాం / పోయింది                                  | stage names                                                                  |
| India time                          | भारत का समय                              | భారత సమయం                                          |                                                                              |
| Plan / suspend                      | प्लान / सस्पेंड                          | ప్లాన్ / సస్పెండ్                                  | platform console                                                             |
| Support access / platform support   | सपोर्ट एक्सेस / प्लेटफॉर्म सपोर्ट        | సపోర్ట్ యాక్సెస్ / ప్లాట్‌ఫామ్ సపోర్ట్             |                                                                              |
| Read-only                           | सिर्फ देखने के लिए                       | చూడడానికి మాత్రమే                                  |                                                                              |
| Platform console / access log       | प्लेटफॉर्म कंसोल / एक्सेस लॉग            | ప్లాట్‌ఫామ్ కన్సోల్ / యాక్సెస్ లాగ్                |                                                                              |
| Merge (duplicate records)           | मिलाएं                                   | కలపండి                                             |                                                                              |

## How to review

The messages live in `apps/web/src/i18n`, one file per feature and language. Each Hindi and
Telugu file mirrors the English file of the same name, key by key, so the three can be read side
by side:

| English                | Hindi                  | Telugu                 | Screens                                                                       |
| ---------------------- | ---------------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `en.ts`                | `hi.ts`                | `te.ts`                | sign-in, two-factor, shell, dashboard, appearance, errors, quick-action names |
| `en-parties.ts`        | `hi-parties.ts`        | `te-parties.ts`        | customers and the customer 360                                                |
| `en-credit.ts`         | `hi-credit.ts`         | `te-credit.ts`         | credit, credit requests and rules                                             |
| `en-loyalty.ts`        | `hi-loyalty.ts`        | `te-loyalty.ts`        | loyalty programme                                                             |
| `en-catalog.ts`        | `hi-catalog.ts`        | `te-catalog.ts`        | products, brands, categories                                                  |
| `en-stock.ts`          | `hi-stock.ts`          | `te-stock.ts`          | stock, low stock, reorder rules                                               |
| `en-transfers.ts`      | `hi-transfers.ts`      | `te-transfers.ts`      | transfers between stores                                                      |
| `en-stock-counts.ts`   | `hi-stock-counts.ts`   | `te-stock-counts.ts`   | stock counts                                                                  |
| `en-purchasing.ts`     | `hi-purchasing.ts`     | `te-purchasing.ts`     | suppliers, purchase orders, goods receipts                                    |
| `en-imports.ts`        | `hi-imports.ts`        | `te-imports.ts`        | spreadsheet imports                                                           |
| `en-workflow.ts`       | `hi-workflow.ts`       | `te-workflow.ts`       | product picker and reasons                                                    |
| `en-leads.ts`          | `hi-leads.ts`          | `te-leads.ts`          | leads, board, opportunities                                                   |
| `en-projects.ts`       | `hi-projects.ts`       | `te-projects.ts`       | projects                                                                      |
| `en-followups.ts`      | `hi-followups.ts`      | `te-followups.ts`      | follow-ups and activities                                                     |
| `en-contracts.ts`      | `hi-contracts.ts`      | `te-contracts.ts`      | contracts                                                                     |
| `en-documents.ts`      | `hi-documents.ts`      | `te-documents.ts`      | documents on records                                                          |
| `en-reports.ts`        | `hi-reports.ts`        | `te-reports.ts`        | reports                                                                       |
| `en-team.ts`           | `hi-team.ts`           | `te-team.ts`           | team, roles and permissions                                                   |
| `en-platform.ts`       | `hi-platform.ts`       | `te-platform.ts`       | platform console (operators): businesses, plans, support access, access log   |
| `en-support-access.ts` | `hi-support-access.ts` | `te-support-access.ts` | Settings → Support access, support banners, the refused support-link message  |

Checklist for each file:

- [ ] The meaning matches the English (open the English file next to it).
- [ ] It sounds like a shop, not a government form; a counter clerk understands it at a glance.
- [ ] Terms match the glossary above; if a term should change, change it here and in every file.
- [ ] Buttons are short (they must fit a phone screen) and use the imperative.
- [ ] Placeholders (`{…}`) are unchanged and the sentence still reads well with real values.
- [ ] `{ one, other }` messages read correctly with 1 and with 5 (Hindi: also with 0).
- [ ] Look at the screen itself: switch the language under **Account security → Language** (or on
      the sign-in page) and walk through the feature on a phone.

When a file is reviewed, note it in the pull request; when all are, remove the draft notice above.
`pnpm verify` checks that every key and placeholder still matches English.

**Not translated (outside the web app's messages):** error and validation messages written by the
API (shown as the server sends them, in English), notification texts created by the server, the
names of custom roles, stores, products and other data people type in, and the font names on
the Appearance screen.
