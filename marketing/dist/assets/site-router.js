const LEGAL_UPDATED = 'August 17, 2026';
const CONTACT = 'info@next-consulting.co';
const LEGAL_PATHS = new Set(['/privacy', '/terms', '/cookies', '/privacy-choices', '/health-privacy']);

const pages = {
  '/privacy': {
    title: 'Privacy Policy',
    description: 'How DashFlo collects, uses, discloses, and protects information across its website, application, API, and lead operations platform.',
    summary: 'This policy explains how information moves through DashFlo, including the important difference between platform users and people represented in lead data.',
    sections: [
      ['scope', '1. Scope and operator', `
        <p>Next Consulting LLC dba DashFlo ("Next Consulting," "DashFlo," "we," "us," or "our") operates the DashFlo website, application, API, and documentation at dashflo.io, app.dashflo.io, api.dashflo.io, and docs.dashflo.io (together, the "Services"). DashFlo is a business software platform for lead intake, validation, distribution, delivery, reporting, billing, and related operations.</p>
        <p>This policy applies to information we process through the Services and in related support and business communications. It does not govern a customer, supplier, lead generator, buyer, law firm, or other third party's independent practices. Those parties may provide their own notices and are responsible for their own collection and use.</p>
      `],
      ['people-and-roles', '2. The people and roles involved', `
        <h3>Platform users</h3>
        <p>Platform users include customer personnel, administrators, suppliers, buyers, and other authorized people who create or receive an account, use the dashboard or portals, configure integrations, or contact us.</p>
        <h3>People represented in lead and call data</h3>
        <p>Many people whose information appears in DashFlo never create a DashFlo account. Their information may be submitted by a customer, supplier, lead-generation website, marketing partner, buyer, API, spreadsheet, call feed, webhook, or another configured source.</p>
        <h3>Our role</h3>
        <p>Our role depends on the data and relationship. We may process lead, call, and customer data on a customer's documented instructions as a processor or service provider. We act for our own purposes when managing accounts, security, billing, support, product operations, legal obligations, and our business. A customer, supplier, buyer, or other recipient may separately act as a business or controller for information it collects, submits, receives, or uses.</p>
      `],
      ['information', '3. Information we process', `
        <p>Depending on how the Services are configured and used, we process the following categories:</p>
        <ul>
          <li><strong>Account and profile information:</strong> name, email address, role, organization or portal relationship, permissions, timezone, invitations, password hash, one-time verification data, password-reset data, and session information.</li>
          <li><strong>Lead and contact information:</strong> name, email address, phone number, ZIP code, city, state, source, URLs, timestamps, identifiers, IP address, user agent, and original and normalized lead payload fields.</li>
          <li><strong>Accident, legal, and health-related lead information:</strong> accident state, type, date or timeframe, accident details, injury status or type, treatment status, type or timing, insurance, fault, attorney status, police-report information, qualification criteria, claim or case context, and dispositions when supplied.</li>
          <li><strong>Consent and attribution information:</strong> TrustedForm certificate URLs and related session data, Jornaya tokens when supplied, opt-in URLs, UTM fields, campaign and source identifiers, Meta browser identifiers, advertising account and creative identifiers, and conversion information.</li>
          <li><strong>Call information:</strong> caller number, name, location, call identifier, source and campaign, duration, disposition, qualification, revenue, and linked lead or buyer information.</li>
          <li><strong>Commercial and financial information:</strong> customer, buyer, and supplier contacts; contracts and onboarding responses; pricing, cost, revenue, margin, payout, wallet, invoice, payment, bank-transaction, advertising-spend, and reconciliation information. Payment-provider references and limited card information such as last four digits may be stored when configured; DashFlo's current public site does not collect card details.</li>
          <li><strong>Technical and operational information:</strong> API and connector metadata, delivery attempts, request and response metadata, validation results, device and browser information, timestamps, authentication events, error details, audit records, system health, migration provenance, and security-related information.</li>
          <li><strong>Content and communications:</strong> support messages, onboarding communications, uploaded documents, report configurations, knowledge-base material, chatbot conversations and memories, prompts, screenshots, and other content users choose to provide.</li>
        </ul>
        <p>The Services can store full inbound payloads and mapped fields because customer-defined APIs and forms vary. Customers and suppliers must limit submissions to information they are authorized to provide and that is necessary for the configured purpose.</p>
      `],
      ['sources', '4. Sources of information', `
        <p>We receive information directly from platform users; from customers, suppliers, lead generators, buyers, law firms, networks, and other business partners; through supplier and customer APIs; from configured spreadsheets, call feeds, webhooks, and uploaded files; from Meta and Google services when connected; from validation and consent-evidence services; and automatically from browsers, servers, and security systems.</p>
        <p>The public marketing site does not contain a lead form or analytics pixel. Account registration and authentication occur on app.dashflo.io. Customer or supplier websites that collect lead data are separate collection points unless DashFlo is expressly identified as operating the form.</p>
      `],
      ['uses', '5. How we use information', `
        <ul>
          <li>Provide, administer, authenticate, and support the Services.</li>
          <li>Receive, normalize, validate, deduplicate, qualify, suppress, route, deliver, and report on leads and calls.</li>
          <li>Apply campaign rules, buyer criteria, caps, pricing, consent-evidence requirements, and do-not-contact controls.</li>
          <li>Operate customer-configured APIs, webhooks, email delivery, spreadsheets, advertising connections, and other integrations.</li>
          <li>Measure source, campaign, buyer, delivery, conversion, cost, revenue, margin, payout, and cash performance.</li>
          <li>Generate invoices and billing reports, reconcile payments and bank transactions, and maintain financial records.</li>
          <li>Respond to support requests, send account and operational communications, and manage onboarding.</li>
          <li>Detect, prevent, investigate, and respond to fraud, abuse, security events, system errors, and unlawful activity.</li>
          <li>Maintain auditability, recover operations, migrate data, back up systems, enforce agreements, and meet legal obligations.</li>
          <li>Improve and troubleshoot the Services, including through user-directed AI features described below.</li>
        </ul>
      `],
      ['disclosures', '6. How information is disclosed', `
        <p>We disclose information as needed for the Services and the applicable business relationship:</p>
        <ul>
          <li><strong>Customers and authorized users:</strong> within the workspace or portal and subject to configured roles and permissions.</li>
          <li><strong>Lead recipients:</strong> configured buyers, law firms, networks, aggregators, resellers, and other intended recipients involved in evaluating, purchasing, servicing, or following up on a lead.</li>
          <li><strong>Suppliers and sources:</strong> for submission results, delivery feedback, returns, reconciliation, reporting, and payouts.</li>
          <li><strong>Customer-configured integrations:</strong> API endpoints, webhooks, CRM systems, email recipients, Google Sheets, Meta services, LeadByte during the documented transition, and other destinations selected by an authorized customer.</li>
          <li><strong>Operational providers:</strong> hosting, database, email, communications, consent evidence, phone or email validation, accounting, payment, banking, advertising, and AI providers used for an enabled function.</li>
          <li><strong>Professional and legal recipients:</strong> advisers, auditors, insurers, regulators, courts, law enforcement, or other parties when reasonably necessary to protect rights, comply with law, or complete a business transaction.</li>
        </ul>
        <p>Optional integrations do not receive information merely because their code exists. Information is sent when the integration is configured and invoked, or when necessary for the relevant service.</p>
      `],
      ['routing', '7. Lead routing and onward use', `
        <p>Lead distribution is a core DashFlo function. A submitted lead may be checked against qualification and routing rules and transmitted to one or more configured recipients. Those recipients may include buyers, customers, service providers, law firms, networks, or other destinations chosen by the customer. Depending on the arrangement, a recipient may independently decide whether to accept the lead and how to contact or serve the person.</p>
        <p>DashFlo records delivery attempts, responses, outcomes, and financial attributes so customers can operate and audit that process. The legal characterization of a transfer as a disclosure, service-provider transfer, sale, or other transaction depends on the contracts, consideration, instructions, and applicable law. We do not make a categorical statement that every lead transfer is or is not a sale.</p>
      `],
      ['sensitive', '8. Sensitive and health-related information', `
        <p>Some legal-services leads contain injury, treatment, accident, insurance, and related information. Depending on the jurisdiction and context, this may be sensitive personal information or consumer health data. It is not necessarily protected health information under HIPAA, and this policy does not claim that HIPAA applies to DashFlo.</p>
        <p>We use these fields for the configured lead purpose, such as qualification, consent evidence, routing, delivery, outcome reporting, suppression, security, and legal recordkeeping. Customers and suppliers must not submit medical records or other sensitive data that the configured workflow does not need.</p>
        <p>See our separate <a href="/health-privacy">Consumer Health Data Privacy Policy</a>.</p>
      `],
      ['ai', '9. AI and knowledge features', `
        <p>Authorized users can use analytics and build-assistance features that send prompts, selected business data, knowledge-base content, or attached screenshots to the configured AI provider. The application supports OpenAI or Anthropic depending on deployment configuration. These features are user initiated and permission controlled. Users should not include personal data in a prompt unless it is necessary and authorized for the intended task.</p>
      `],
      ['retention', '10. Retention', `
        <p>DashFlo does not currently enforce one fixed retention period for every category. Retention varies according to customer instructions, the operational lifecycle of a lead or account, audit and recovery needs, dispute and fraud prevention, financial and tax obligations, contract requirements, backups, and applicable law.</p>
        <p>The application supports archiving and authorized deletion of leads and other records. Archiving hides a record from ordinary reporting but does not delete it. Some routing, suppression, consent, migration, and audit records are deliberately retained for traceability. Backup copies may remain until the applicable backup cycle expires. We delete or deidentify information when required and permitted, but a verified request may need to be coordinated with the customer or source that controls the record.</p>
      `],
      ['security', '11. Security', `
        <p>We use administrative, technical, and organizational measures designed to protect information in light of its nature and the Services. Repository-backed controls include role and row scoping, password hashing, HttpOnly session cookies, CSRF protection, request limits, API-key hashing for newly issued keys, credential redaction, audit records, and restricted public routes. No system is completely secure, and we cannot guarantee that unauthorized access, loss, or misuse will never occur.</p>
      `],
      ['transfers', '12. Processing locations', `
        <p>DashFlo and its configured providers may process information in the United States and in other locations where authorized personnel or providers operate. The repository does not establish that DashFlo offers services in the European Economic Area or United Kingdom or that a particular international-transfer mechanism applies. Customers with cross-border requirements should contact us before submitting regulated data.</p>
      `],
      ['rights', '13. Privacy rights and requests', `
        <p>Depending on where you live and the circumstances, you may have rights to request access, correction, deletion, a portable copy, restriction, objection, withdrawal of consent, or an appeal. You may also have a right to opt out of certain sales, sharing, targeted advertising, profiling, or uses of sensitive information.</p>
        <p>Visit <a href="/privacy-choices">Privacy Choices</a> or email <a href="mailto:${CONTACT}?subject=Privacy%20Request">${CONTACT}</a>. Describe the request, your relationship to DashFlo, the business or website through which you submitted information, and any email, phone number, or lead reference needed to locate it. Do not email a password, government identifier, medical record, or full payment-card number.</p>
        <p>We may need to verify identity and authority. If a customer controls the requested information, we may refer the request to that customer or assist it with a response. Authorized agents may submit requests where allowed, subject to verification of authority. We will not discriminate against you for exercising an applicable privacy right.</p>
      `],
      ['us-state', '14. United States state disclosures', `
        <p>State privacy laws apply only when their scope and thresholds are met. The repository does not establish DashFlo's revenue, California consumer volume, percentage of revenue from data transfers, geographic targeting, or all customer contract terms. Accordingly, we do not state that a particular omnibus state privacy law applies in every circumstance.</p>
        <p>For California classification purposes, information processed by DashFlo can include identifiers; customer records; commercial information; internet or electronic network activity; geolocation at state, city, ZIP, or IP-derived level; professional information; inferences; account credentials; and health-related sensitive personal information. Sources, uses, and recipient categories are described above. We provide a request channel for access, correction, deletion, portability, and opt-out or limitation requests if applicable.</p>
        <p>Because lead distribution may involve consideration and onward disclosure, the contracts and business practices must be reviewed before making a definitive statement about whether any transfer is a statutory sale. The public <a href="/privacy-choices">Privacy Choices</a> page accepts sale or sharing opt-out requests without requiring that legal question to be resolved in advance.</p>
      `],
      ['children', '15. Children', `
        <p>DashFlo is business software and is not directed to children. The Services do not include an age-verification mechanism for people represented in customer-submitted lead data. Customers and suppliers must not submit children's information unless they have lawful authority and the configured use is appropriate. Contact us if you believe a child's information was submitted improperly.</p>
      `],
      ['changes-contact', '16. Changes and contact', `
        <p>We may update this policy to reflect changes in the Services, practices, or law. We will post the updated version here and change the date above. If a change materially affects information already collected, we will provide additional notice or seek consent when required.</p>
        <div class="legal-note"><strong>Privacy contact</strong><p>Next Consulting LLC dba DashFlo<br><a href="mailto:${CONTACT}">${CONTACT}</a></p></div>
      `],
    ],
  },
  '/terms': {
    title: 'Terms of Service',
    description: 'Terms governing business use of DashFlo, a lead-management, distribution, reporting, and operations platform.',
    summary: 'These Terms govern access to DashFlo by customers, suppliers, buyers, and other authorized business users.',
    sections: [
      ['agreement', '1. Agreement and scope', `
        <p>These Terms of Service ("Terms") are a legal agreement between Next Consulting LLC dba DashFlo ("DashFlo," "we," "us," or "our") and the person or organization using the Services ("Customer" or "you"). The "Services" include the DashFlo website, application, API, documentation, portals, and related support.</p>
        <p>By accessing or using the Services, you agree to these Terms. If you use the Services for an organization, you represent that you have authority to bind it. A signed order form, statement of work, data processing addendum, or other written agreement may add to or modify these Terms. The signed agreement controls if there is a conflict.</p>
      `],
      ['eligibility', '2. Eligibility and accounts', `
        <p>You must be legally capable of entering a contract and authorized for the organization you represent. You must provide accurate account information, keep it current, and protect passwords, session access, API keys, integration credentials, and recovery methods. You are responsible for authorized-user activity under your account and for promptly notifying us of suspected compromise.</p>
        <p>You may not share individual credentials or API keys outside the authorized scope. Administrators are responsible for user roles, portal relationships, permissions, connected accounts, and disabling access when it is no longer needed.</p>
      `],
      ['services', '3. Services and changes', `
        <p>DashFlo provides configurable tools for lead intake, validation, suppression, routing, delivery, reporting, advertising attribution, billing operations, portals, integrations, and related workflows. Features may differ by configuration, plan, deployment stage, or third-party availability.</p>
        <p>We may improve, modify, replace, or discontinue features. We do not promise that every preview, planned, migration, or optional integration will become or remain generally available. Material changes affecting an active paid service will be handled under the applicable commercial agreement.</p>
      `],
      ['customer-data', '4. Customer Data', `
        <p>As between the parties, Customer retains its rights in data, content, configurations, and materials it submits to the Services ("Customer Data"). Customer grants DashFlo a nonexclusive, worldwide license to host, copy, process, transmit, display, and otherwise use Customer Data only as needed to provide, secure, support, improve, and comply with law in connection with the Services.</p>
        <p>Customer is responsible for the accuracy, quality, legality, and means of acquiring Customer Data; for its instructions and configured recipients; and for maintaining its own source records where required. DashFlo does not acquire ownership of Customer Data.</p>
      `],
      ['lead-data', '5. Lead data and lawful collection', `
        <p>Customer represents and warrants that it has the rights, notices, permissions, consents, and other lawful basis needed to submit Customer Data, instruct DashFlo to process it, and disclose it to configured recipients. This includes lead and call data, accident or health-related information, marketing attribution, consent evidence, and suppression instructions.</p>
        <p>Customer must provide required notices at or before collection, honor applicable privacy and marketing choices, keep consent evidence, and configure the Services consistently with those obligations. Customer must not direct DashFlo to collect, process, or distribute information unlawfully. DashFlo does not guarantee that a customer's form, list, consent language, campaign, recipient, or communication complies with law.</p>
      `],
      ['communications', '6. Calls, texts, and email', `
        <p>Customer is solely responsible for determining whether and how it or its recipients may call, text, email, or otherwise contact a person. Customer must comply with applicable telemarketing, do-not-call, consent, identification, time-of-day, revocation, and recordkeeping requirements, including the Telephone Consumer Protection Act and similar laws where they apply.</p>
        <p>DashFlo routing, phone validation, consent-certificate storage, or suppression tools assist operations but do not constitute legal advice or a guarantee of compliance. Customer must stop or update communications when consent is revoked or a valid opt-out is received.</p>
      `],
      ['api', '7. API and integrations', `
        <p>You may use an API or integration only as documented and authorized. You must protect credentials, use reasonable request rates, validate destinations, and rotate compromised keys. You may not evade access controls or limits, interfere with availability, use another party's credentials, or use the API to obtain data you are not authorized to access.</p>
        <p>Third-party services are governed by their own terms and privacy practices. DashFlo is not responsible for a third party's service, data handling, outage, API change, or decision to suspend an account. You authorize DashFlo to exchange data with a third party when you connect or configure that service.</p>
      `],
      ['acceptable-use', '8. Acceptable use', `
        <p>You must not use the Services to:</p>
        <ul>
          <li>violate law, another person's rights, or a binding industry rule;</li>
          <li>collect, upload, buy, sell, share, or contact people without required authority, notice, or consent;</li>
          <li>send spam, unlawful marketing, harassing messages, or deceptive communications;</li>
          <li>impersonate another person, misrepresent a source or consent record, or falsify lead information;</li>
          <li>upload malware, exploit code, or content intended to disrupt or damage systems;</li>
          <li>probe, scan, test, circumvent, or access systems or data without written authorization;</li>
          <li>scrape or extract data except through authorized product features and APIs;</li>
          <li>expose credentials or confidential data, or attempt to access another customer's workspace;</li>
          <li>use the Services for decisions that produce unlawful discrimination; or</li>
          <li>submit medical records, government identifiers, payment-card data, or other sensitive data not needed for the configured service.</li>
        </ul>
      `],
      ['fees', '9. Fees and payment', `
        <p>Fees, usage terms, invoicing, taxes, payment timing, and any renewal or cancellation terms are stated in the applicable order form, proposal, invoice, or other commercial agreement. The public website does not create a self-service subscription, refund period, or automatic-renewal promise. You must pay undisputed amounts when due and provide accurate billing information.</p>
      `],
      ['ip', '10. Intellectual property and feedback', `
        <p>DashFlo and its licensors retain all rights in the Services, software, documentation, designs, brands, and technology, excluding Customer Data. Subject to these Terms and payment obligations, we grant Customer a limited, nonexclusive, nontransferable right to use the Services for its internal business purposes during the applicable service term.</p>
        <p>If you provide feedback, you permit us to use it without restriction or payment, provided we do not identify you publicly without permission.</p>
      `],
      ['confidentiality', '11. Confidentiality', `
        <p>Each party may receive nonpublic information that should reasonably be understood as confidential. The receiving party will use it only for the relationship, protect it with reasonable care, and disclose it only to personnel and providers who need it and are subject to appropriate duties. These obligations do not apply to information lawfully public, already known without restriction, independently developed, or lawfully received from another source.</p>
        <p>A party may disclose confidential information when legally required after giving notice where permitted. Customer Data remains subject to the <a href="/privacy">Privacy Policy</a> and any applicable data processing terms.</p>
      `],
      ['security-privacy', '12. Security and privacy', `
        <p>Each party will use reasonable safeguards appropriate to its role. Customer is responsible for secure endpoints, user administration, integration credentials, lawful instructions, and prompt incident reporting. Our privacy practices are described in the <a href="/privacy">Privacy Policy</a> and <a href="/health-privacy">Consumer Health Data Privacy Policy</a>.</p>
      `],
      ['availability', '13. Availability and support', `
        <p>We aim to operate the Services reliably, but interruptions may occur due to maintenance, third parties, internet conditions, security events, or circumstances outside reasonable control. Unless a signed agreement says otherwise, no service-level commitment applies. We may use maintenance windows and make emergency changes to protect the Services or data.</p>
      `],
      ['suspension', '14. Suspension and termination', `
        <p>We may suspend access when reasonably necessary to address a security risk, unlawful or abusive use, material breach, nonpayment, third-party restriction, or risk to the Services or others. Where practical, we will give notice and an opportunity to cure.</p>
        <p>Either party may terminate as stated in the applicable commercial agreement. On termination, access ends and Customer must stop using the Services. Data return and deletion are handled under the applicable agreement, customer instructions, technical capabilities, backup cycles, and law. Provisions that by their nature should survive will survive, including payment, confidentiality, intellectual property, disclaimers, liability, and indemnity.</p>
      `],
      ['disclaimers', '15. Disclaimers', `
        <p>To the extent permitted by law, the Services are provided "as is" and "as available." DashFlo disclaims implied warranties of merchantability, fitness for a particular purpose, title, and noninfringement. We do not warrant uninterrupted or error-free operation, a particular commercial result, buyer acceptance, lead quality, legal compliance, or the availability or accuracy of third-party services and data.</p>
        <p>DashFlo is not a law firm, medical provider, telemarketing-compliance service, credit bureau, payment institution, or insurer. Reports, validation results, AI output, and operational recommendations are informational tools and must be reviewed by qualified personnel.</p>
      `],
      ['liability', '16. Limitation of liability', `
        <p>To the maximum extent permitted by law, neither party will be liable for indirect, incidental, special, exemplary, punitive, or consequential damages, or for lost profits, revenue, goodwill, or data, arising from these Terms or the Services, even if advised that such loss is possible. Each party remains responsible for liability that cannot lawfully be limited.</p>
        <p>Any negotiated monetary cap or allocation of risk in a signed order form or other agreement controls. These public Terms do not invent a subscription-based liability cap where no commercial amount has been established.</p>
      `],
      ['indemnity', '17. Indemnity', `
        <p>Customer will defend and indemnify DashFlo and its personnel from third-party claims, damages, penalties, and reasonable costs arising from Customer Data, Customer's collection or use of personal information, configured communications or recipients, violation of law or these Terms, or infringement caused by materials Customer provides. This obligation does not apply to the extent a claim results from DashFlo's breach of these Terms or willful misconduct.</p>
      `],
      ['disputes', '18. Disputes and applicable law', `
        <p>Please contact us first so the parties can try to resolve a dispute in good faith. A governing-law, venue, or dispute-resolution provision in a signed agreement controls. If no signed agreement supplies one, applicable law determines those questions. These Terms do not publish a governing state or arbitration location that has not been established by the operator.</p>
      `],
      ['general', '19. General terms', `
        <p>You may not assign these Terms without our consent, except in connection with a merger, reorganization, or sale of substantially all relevant assets. We may assign them in connection with a business transaction or restructuring. Neither party is liable for delay caused by events beyond reasonable control. Failure to enforce a provision is not a waiver. If a provision is unenforceable, the remainder stays effective. These Terms and incorporated written agreements are the entire agreement about their subject matter.</p>
      `],
      ['contact', '20. Contact', `
        <div class="legal-note"><strong>Next Consulting LLC dba DashFlo</strong><p><a href="mailto:${CONTACT}">${CONTACT}</a></p></div>
      `],
    ],
  },
  '/cookies': {
    title: 'Cookie Policy',
    description: 'Cookies and browser storage used by the DashFlo marketing website and application.',
    summary: 'DashFlo uses required account storage and functional preferences. The public marketing site currently has no analytics or advertising pixels.',
    sections: [
      ['overview', '1. Overview', `
        <p>This policy explains cookies, local storage, session storage, and similar browser technologies used by DashFlo. A cookie is a small text value stored by a browser and sent with matching requests. Local and session storage remain in the browser and are not automatically attached to each request.</p>
      `],
      ['marketing', '2. Public marketing website', `
        <p>The public website at dashflo.io stores one first-party preference named <code>dashflo-theme</code> in local storage. It records whether you selected the light or dark theme and remains until you clear site data. It is functional and not used to identify you across websites.</p>
        <p>The marketing site currently contains no Google Analytics, Meta Pixel, Hotjar, Intercom, advertising tag, or similar tracking script. It does not set an analytics or advertising cookie. Because no nonessential tracking is currently used on this site, we do not display a tracking-consent banner.</p>
        <p>The site loads DM Sans and IBM Plex Mono styles from Google Fonts. This causes the browser to request font resources from Google and disclose ordinary network information such as IP address, browser headers, and request time. DashFlo does not use that request to build its own advertising profile.</p>
      `],
      ['application', '3. DashFlo application', `
        <ul>
          <li><strong><code>dashos_token</code>:</strong> a first-party authentication cookie used to keep an account signed in. It is HttpOnly, uses SameSite=Lax, is Secure in production, and has a configured maximum age of about 30 days.</li>
          <li><strong>Sidebar preference cookie:</strong> a first-party functional cookie used by the application interface to remember whether the sidebar is open. The application sets a maximum age of seven days.</li>
          <li><strong>Authentication token in local storage:</strong> the current application also keeps a bearer token under <code>dashos_access_token</code> for compatibility with the browser API client. It remains until logout or site data is cleared. This is required for the current authenticated experience and is not an advertising identifier.</li>
          <li><strong>Interface preferences:</strong> theme, timezone, table columns, filters, page size, panel widths, collapsed states, preview role, and review-capture preferences may be saved in local storage.</li>
          <li><strong>Temporary workflow state:</strong> session storage is used for an authenticated page-capture review queue, return path, and masking preference. It normally clears when the browser session ends.</li>
        </ul>
      `],
      ['integrations', '4. Third-party services', `
        <p>When an authorized user deliberately starts a Meta or Google connection, the browser may open those providers' authorization pages or load their account-selection scripts. Those third parties may use their own cookies under their policies. Optional integration code does not mean a provider is active for every user.</p>
      `],
      ['controls', '5. Your controls', `
        <p>You can change the DashFlo theme using the theme button. Browser settings can block or delete cookies and site storage. Blocking required authentication storage will prevent sign-in or cause parts of the application to stop working. Private-browsing modes may remove preferences sooner.</p>
        <p>If DashFlo introduces nonessential analytics or advertising technology that requires consent, we will update this policy and provide appropriate controls before using it where required.</p>
      `],
      ['contact', '6. Contact', `
        <p>Questions about browser storage can be sent to <a href="mailto:${CONTACT}?subject=Cookie%20Policy">${CONTACT}</a>.</p>
      `],
    ],
  },
  '/privacy-choices': {
    title: 'Privacy Choices',
    description: 'Submit a privacy request to DashFlo, including access, correction, deletion, portability, opt-out, limitation, withdrawal, or appeal requests.',
    summary: 'Tell us what you need and how your information reached DashFlo. We will route the request to the right organization and verify it securely.',
    sections: [
      ['request', 'Make a request', `
        <div class="choice-grid">
          ${choiceCard('ACCESS', 'Access my information', 'Ask whether DashFlo processes information about you and request applicable details.', 'Access')}
          ${choiceCard('CORRECT', 'Correct my information', 'Ask us or the responsible customer to correct inaccurate information.', 'Correction')}
          ${choiceCard('DELETE', 'Delete my information', 'Request deletion, subject to identity verification and applicable exceptions.', 'Deletion')}
          ${choiceCard('COPY', 'Obtain a copy', 'Request a portable copy of applicable information in a usable format.', 'Portability')}
          ${choiceCard('OPT OUT', 'Opt out of sale or sharing', 'Submit an opt-out request if a transfer is covered by an applicable privacy law.', 'Sale or Sharing Opt-Out')}
          ${choiceCard('LIMIT', 'Limit sensitive information use', 'Ask us to limit covered uses or disclosures of sensitive personal information.', 'Sensitive Information Limitation')}
          ${choiceCard('WITHDRAW', 'Withdraw health-data consent', 'Withdraw applicable consent for future collection or sharing of consumer health data.', 'Withdraw Consumer Health Data Consent')}
          ${choiceCard('APPEAL', 'Appeal a privacy decision', 'Ask for review if a covered privacy request was denied.', 'Privacy Appeal')}
        </div>
        <p>You can also email <a href="mailto:${CONTACT}?subject=Privacy%20Request">${CONTACT}</a>. There is no automated request portal or insecure public lookup. Email begins a reviewed process.</p>
      `],
      ['include', 'What to include', `
        <ul>
          <li>Your name and a reliable way to contact you.</li>
          <li>The request type and the state or country where you live.</li>
          <li>Whether you are a DashFlo user or a person represented in lead or call data.</li>
          <li>The customer, supplier, website, campaign, or business through which you submitted information, if known.</li>
          <li>The email address, phone number, or reference associated with the record.</li>
        </ul>
        <p>Do not send a password, API key, government identifier, complete medical record, or full payment-card number by email.</p>
      `],
      ['process', 'Verification and response', `
        <p>We may ask for information reasonably necessary to verify identity, authority, and the record at issue. We use verification information only for the request and related recordkeeping. If DashFlo processes the information for a customer, we may refer the request to that customer or assist it in responding.</p>
        <p>An authorized agent may submit a request where applicable. We may ask for signed permission and may verify identity directly with the person. Response timing and available rights depend on the law and context.</p>
      `],
      ['signals', 'Browser opt-out signals', `
        <p>The public marketing site does not currently use cross-context behavioral advertising or analytics tags. DashFlo's lead-distribution transfers are driven by customer configuration rather than website tracking. The application does not currently expose an automated Global Privacy Control handler for lead records, so email is the reliable channel for a lead-data opt-out request. This page will be updated if the technical mechanism changes.</p>
      `],
      ['appeals', 'Appeals and complaints', `
        <p>If we deny a right that includes an appeal, reply to the decision or email <a href="mailto:${CONTACT}?subject=Privacy%20Appeal">${CONTACT}</a> with "Privacy Appeal" in the subject line. You may also contact the privacy regulator or attorney general in your jurisdiction.</p>
      `],
    ],
  },
  '/health-privacy': {
    title: 'Consumer Health Data Privacy Policy',
    description: 'How DashFlo processes consumer health data in accident and legal lead workflows, and how consumers may exercise health-data rights.',
    summary: 'This separate policy covers injury, treatment, accident, insurance, and related information that may qualify as consumer health data.',
    sections: [
      ['categories', '1. Consumer health data we collect', `
        <p>Depending on the fields a customer or supplier configures, DashFlo may collect or receive information linked to a person that identifies or permits inferences about physical health status or a request for health-related or legal services. Categories include:</p>
        <ul>
          <li>injury status, injury type, symptoms, accident details, and accident date or timeframe;</li>
          <li>medical treatment status, type, timing, and related qualification information;</li>
          <li>insurance status and information related to an accident or injury;</li>
          <li>fault, attorney status, police-report information, and claim or case context when linked to health circumstances;</li>
          <li>contact, location, source, consent, and attribution information linked to the health-related inquiry; and</li>
          <li>inferences, lead qualification, routing, delivery, disposition, and outcome data derived from these fields.</li>
        </ul>
        <p>DashFlo is not designed to receive clinical charts or complete medical records. Customers and suppliers should not submit health data that is not necessary for the configured lead workflow.</p>
      `],
      ['sources', '2. Sources', `
        <p>Consumer health data may come from the consumer through a customer or supplier's form or call; from DashFlo customers, suppliers, lead generators, marketing partners, buyers, law firms, networks, or aggregators; from APIs, spreadsheets, call feeds, webhooks, uploaded files, and configured integrations; and from information generated during validation, qualification, routing, delivery, and outcome reporting.</p>
      `],
      ['purposes', '3. Why and how we process it', `
        <p>DashFlo processes these categories to receive and normalize a lead; validate required fields and consent evidence; detect duplicates and suppression matches; determine whether a lead meets configured criteria; route and deliver it to intended recipients; record acceptance, rejection, return, and disposition; provide portals, reporting, billing, audit, security, support, and legal recordkeeping; and carry out customer instructions.</p>
        <p>DashFlo may act as a processor for a customer and may act for its own operational, security, account, and legal purposes. Collection or sharing that requires consumer consent must be supported by the responsible collection party's valid consent or another legally permitted basis. DashFlo's storage of a TrustedForm URL or Jornaya token is evidence tooling and is not itself a guarantee that the underlying consent is legally sufficient.</p>
      `],
      ['sharing', '4. Consumer health data we share', `
        <p>The categories shared can include the contact, accident, injury, treatment, insurance, qualification, consent, and attribution data required by a configured delivery. DashFlo may share those categories with:</p>
        <ul>
          <li>the DashFlo customer and its authorized users;</li>
          <li>configured buyers, law firms, service providers, networks, aggregators, resellers, and other intended lead recipients;</li>
          <li>suppliers or sources for delivery feedback, returns, reconciliation, and request handling;</li>
          <li>hosting, validation, consent-evidence, communications, security, and support processors;</li>
          <li>customer-selected APIs, webhooks, CRM systems, email recipients, spreadsheets, and other integrations; and</li>
          <li>regulators, law enforcement, advisers, or transaction recipients where lawfully required or permitted.</li>
        </ul>
        <p>Next Consulting LLC has no affiliate identified in the repository with which it shares consumer health data. Optional connectors do not receive data unless enabled and used. The public marketing website has no third-party advertising or analytics tracker that collects consumer health data over time and across unrelated websites.</p>
      `],
      ['rights', '5. Consumer health data rights', `
        <p>Where applicable, you may request confirmation of whether we collect, share, or sell your consumer health data; access to that data; a list of third parties or affiliates that received it; correction; deletion; withdrawal of consent for future collection or sharing; or an appeal of a refusal.</p>
        <p>Email <a href="mailto:${CONTACT}?subject=Consumer%20Health%20Data%20Request">${CONTACT}</a> or use <a href="/privacy-choices">Privacy Choices</a>. State that the request concerns consumer health data and identify the source, website, business, email address, phone number, or reference needed to locate the record. You do not need to create a new account. Do not send medical records or government identifiers by email.</p>
        <p>We may verify identity and authority. If a customer controls the information, we may refer the request to it or assist it. Subject to law, deletion may require notifying processors and third parties and may take additional time for archived or backup systems. Withdrawing consent affects future processing and does not necessarily invalidate processing already completed on another lawful basis.</p>
      `],
      ['sale', '6. Sale and authorization', `
        <p>The application supports lead transfers that may involve payment or other consideration. Whether a particular transfer is a sale of consumer health data depends on the facts, contracts, consumer direction, exemptions, and applicable law. DashFlo does not state that every transfer is or is not a sale.</p>
        <p>Where a transfer is legally treated as a sale of consumer health data, the party responsible for the sale must obtain the separate, signed authorization required by applicable law before the sale. A general website acceptance, ordinary lead consent, or platform configuration is not a substitute for a legally required health-data sale authorization.</p>
      `],
      ['changes', '7. Changes and contact', `
        <p>We will post material changes to this policy before collecting, using, or sharing additional consumer health data where notice or consent is required. The effective date appears above.</p>
        <div class="legal-note"><strong>Consumer health data contact</strong><p>Next Consulting LLC dba DashFlo<br><a href="mailto:${CONTACT}">${CONTACT}</a></p></div>
      `],
    ],
  },
};

function choiceCard(label, title, text, subject) {
  return `<article class="choice-card"><small>${label}</small><h3>${title}</h3><p>${text}</p><a href="mailto:${CONTACT}?subject=${encodeURIComponent(subject)}">Start by email</a></article>`;
}

function brand() {
  return `<a class="brand" href="/" aria-label="DashFlo home"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span><span>Dash<span>Flo</span></span></a>`;
}

function themeButton(theme = document.documentElement.dataset.theme || 'dark') {
  return `<button class="theme-toggle" type="button" aria-label="Switch color theme" aria-pressed="${theme === 'dark'}"><span aria-hidden="true">☀</span><span aria-hidden="true">☾</span><span class="toggle-knob ${theme === 'dark' ? 'dark' : ''}"></span></button>`;
}

function footerMarkup() {
  return `
    <div class="container footer-grid">
      <div class="footer-brand">${brand()}<p class="legal-identity">DashFlo is operated by Next Consulting LLC. Lead operations, distribution, reporting, and financial visibility in one platform.</p><a href="mailto:${CONTACT}">${CONTACT}</a></div>
      <div class="footer-col"><b>PRODUCT</b><a href="https://app.dashflo.io">Login</a><a href="https://docs.dashflo.io">Documentation</a></div>
      <div class="footer-col"><b>LEGAL</b><a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Service</a><a href="/cookies">Cookie Policy</a><a href="/privacy-choices">Privacy Choices</a></div>
      <div class="footer-col"><b>HEALTH PRIVACY</b><a href="/health-privacy">Consumer Health Data Privacy Policy</a><a href="mailto:${CONTACT}?subject=Consumer%20Health%20Data%20Request">Health Data Request</a></div>
    </div>
    <div class="container footer-bottom"><span>© ${new Date().getFullYear()} Next Consulting LLC dba DashFlo. All rights reserved.</span><span>From ad spend to cash.</span></div>`;
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('dashflo-theme', theme); } catch {}
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#080c12' : '#f5f7f8');
  const button = document.querySelector('.theme-toggle');
  if (button) {
    button.setAttribute('aria-pressed', String(theme === 'dark'));
    button.querySelector('.toggle-knob')?.classList.toggle('dark', theme === 'dark');
  }
}

function installTheme() {
  let stored = 'dark';
  try { stored = localStorage.getItem('dashflo-theme') || 'dark'; } catch {}
  setTheme(stored === 'light' ? 'light' : 'dark');
  document.querySelector('.theme-toggle')?.addEventListener('click', () => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
}

function setMeta(path, page) {
  const canonical = `https://dashflo.io${path}`;
  document.title = `${page.title} | DashFlo`;
  document.querySelector('meta[name="description"]')?.setAttribute('content', page.description);
  document.querySelector('link[rel="canonical"]')?.setAttribute('href', canonical);
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', `${page.title} | DashFlo`);
  document.querySelector('meta[property="og:description"]')?.setAttribute('content', page.description);
  document.querySelector('meta[property="og:url"]')?.setAttribute('content', canonical);
  let robots = document.querySelector('meta[name="robots"]');
  if (!robots) {
    robots = document.createElement('meta');
    robots.name = 'robots';
    document.head.appendChild(robots);
  }
  robots.content = 'index, follow';
}

function renderLegal(path) {
  const page = pages[path];
  document.body.className = 'legal-body';
  setMeta(path, page);
  const toc = page.sections.map(([id, title]) => `<a href="#${id}">${title.replace(/^\d+\.\s*/, '')}</a>`).join('');
  const content = page.sections.map(([id, title, html]) => `<section id="${id}" aria-labelledby="${id}-title"><h2 id="${id}-title">${title}</h2>${html}</section>`).join('');
  document.getElementById('root').innerHTML = `
    <a class="skip-link" href="#legal-content">Skip to legal content</a>
    <header class="site-header is-compact"><div class="header-inner">${brand()}<nav aria-label="Primary"><a href="/privacy" ${path === '/privacy' ? 'aria-current="page"' : ''}>Privacy</a><a href="/terms" ${path === '/terms' ? 'aria-current="page"' : ''}>Terms</a><a href="https://docs.dashflo.io">Docs</a><a class="sign-in" href="https://app.dashflo.io">Login</a></nav><div class="header-actions">${themeButton()}</div></div></header>
    <main id="legal-content" class="legal-shell">
      <div class="legal-hero"><div class="container"><span class="legal-eyebrow">LEGAL / DASHFLO</span><h1>${page.title}</h1><p class="legal-summary">${page.summary}</p><div class="legal-meta"><span>Effective ${LEGAL_UPDATED}</span><span>Next Consulting LLC dba DashFlo</span></div></div></div>
      <div class="container legal-layout"><aside class="legal-toc" aria-label="On this page"><strong>On this page</strong>${toc}</aside><article class="legal-content">${content}</article></div>
    </main>
    <footer class="legal-site-footer">${footerMarkup()}</footer>`;
  installTheme();
}

function patchHomepage() {
  const apply = () => {
    const footer = document.querySelector('footer');
    if (!footer) return false;
    footer.classList.add('legal-site-footer');
    footer.innerHTML = footerMarkup();
    for (const link of document.querySelectorAll('a[href="https://app.dashflo.io/register"]')) {
      link.href = `mailto:${CONTACT}?subject=DashFlo%20Access%20Request`;
      link.textContent = 'Request Access';
    }
    for (const link of document.querySelectorAll('a[href^="mailto:"]')) {
      if (!link.href.includes(CONTACT)) link.href = `mailto:${CONTACT}?subject=DashFlo%20Enterprise`;
    }
    return true;
  };
  if (apply()) return;
  const observer = new MutationObserver(() => {
    if (apply()) observer.disconnect();
  });
  observer.observe(document.getElementById('root'), { childList: true, subtree: true });
}

const normalizedPath = location.pathname.length > 1 ? location.pathname.replace(/\/+$/, '') : '/';
if (LEGAL_PATHS.has(normalizedPath)) {
  renderLegal(normalizedPath);
} else {
  await import('/assets/index-od46Pw2o.js');
  patchHomepage();
}
