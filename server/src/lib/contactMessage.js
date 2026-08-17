// Public contact form: validation and message construction.
//
// Everything here is pure so it can be exercised directly. The route module
// handles transport, rate limiting, and delivery.
//
// Two rules shape this file.
//
// The destination is never supplied by the caller. A public endpoint that
// accepts a recipient is an open relay, so the recipient is passed in from
// server configuration and the submitted body has no say in it.
//
// The visitor's address is used for Reply-To, never for From. Sending as the
// visitor is a forgery that SPF and DMARC are specifically built to reject, and
// it would put our delivery reputation behind whatever address a stranger
// typed. From stays an SMTP-authorised DashFlo sender.

export const CONTACT_LIMITS = Object.freeze({
  name: 120,
  email: 254,
  company: 160,
  subject: 200,
  message: 5000,
});

export const CONTACT_TOPICS = Object.freeze({
  sales: 'Sales',
  account: 'Account Support',
  technical: 'Technical Support',
  billing: 'Billing',
  privacy: 'Privacy',
  other: 'Other',
});

// Deliberately conservative. This decides whether we will put a string in a
// Reply-To header, so anything ambiguous is refused rather than escaped.
const EMAIL = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[a-z]{2,}$/i;

const asText = (value) => (typeof value === 'string' ? value : '');

// Control characters have no place in a submitted field. Carriage return and
// line feed in particular are how a header is forged, so they are removed
// before a value can reach one.
const stripControl = (value) => asText(value).replace(/[\u0000-\u001f\u007f]/g, ' ');

const collapse = (value) => stripControl(value).replace(/\s+/g, ' ').trim();

// The message body keeps its line breaks; only carriage returns and other
// control characters are normalised away.
const cleanBody = (value) => asText(value)
  .replace(/\r\n?/g, '\n')
  .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
  .trim();

export function validateContact(input = {}) {
  const value = {
    name: collapse(input.name),
    email: collapse(input.email).toLowerCase(),
    company: collapse(input.company),
    topic: Object.hasOwn(CONTACT_TOPICS, input.topic) ? input.topic : 'other',
    subject: collapse(input.subject),
    message: cleanBody(input.message),
  };

  const fields = {};

  if (!value.name) fields.name = 'Enter your name.';
  else if (value.name.length > CONTACT_LIMITS.name) fields.name = 'Name is too long.';

  if (!value.email) fields.email = 'Enter your email address.';
  else if (value.email.length > CONTACT_LIMITS.email) fields.email = 'Email address is too long.';
  else if (!EMAIL.test(value.email)) fields.email = 'Enter a valid email address.';

  if (value.company.length > CONTACT_LIMITS.company) fields.company = 'Company name is too long.';

  if (!value.subject) fields.subject = 'Enter a subject.';
  else if (value.subject.length > CONTACT_LIMITS.subject) fields.subject = 'Subject is too long.';

  if (!value.message) fields.message = 'Enter a message.';
  else if (value.message.length > CONTACT_LIMITS.message) fields.message = 'Message is too long.';

  return { valid: Object.keys(fields).length === 0, fields, value };
}

// A submission that fills the honeypot is a bot. The caller accepts it and
// discards it rather than returning an error, so the bot learns nothing about
// which of its fields gave it away.
export const isHoneypotFilled = (input = {}) => collapse(input.website).length > 0;

// Build the RFC 5322 From value. When the configured sender already carries a
// display name it is used unchanged, so a deployment can set the whole header
// itself.
export function senderIdentity(from, fromName) {
  const address = String(from || '').trim();
  if (!address) return '';
  if (address.includes('<')) return stripControl(address);
  const name = collapse(fromName);
  if (!name) return stripControl(address);
  return `${JSON.stringify(name)} <${stripControl(address)}>`;
}

export function buildContactMessage({ value, recipient, from, fromName }) {
  const topicLabel = CONTACT_TOPICS[value.topic] || CONTACT_TOPICS.other;

  const lines = [
    `Topic: ${topicLabel}`,
    `Name: ${value.name}`,
    `Email: ${value.email}`,
  ];
  if (value.company) lines.push(`Company: ${value.company}`);
  lines.push('', value.message, '', '--', 'Sent from the DashFlo contact form at dashflo.io/contact.');

  return {
    to: recipient,
    from: senderIdentity(from, fromName),
    // Support replies to the visitor normally. This is the only place the
    // submitted address is used as an address, and it has already been matched
    // against EMAIL, so it cannot contain a comma, angle bracket, or newline.
    replyTo: value.email,
    subject: `[${topicLabel}] ${value.subject}`.slice(0, 240),
    text: lines.join('\n'),
  };
}

export default { validateContact, buildContactMessage, isHoneypotFilled, senderIdentity, CONTACT_LIMITS, CONTACT_TOPICS };
