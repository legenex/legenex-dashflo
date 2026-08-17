import { describe, it, expect } from 'vitest';
import {
  validateContact,
  buildContactMessage,
  isHoneypotFilled,
  senderIdentity,
  CONTACT_LIMITS,
} from '../src/lib/contactMessage.js';

// The contact form is the only unauthenticated write surface on the marketing
// site. These cover the two things that turn such a form into a liability: an
// attacker choosing the recipient, and an attacker reaching the mail headers.

const good = {
  name: 'Dana Reyes',
  email: 'Dana@Example.com',
  company: 'Reyes Media',
  topic: 'billing',
  subject: 'Invoice question',
  message: 'Line one.\nLine two.',
  website: '',
};

describe('contact submission validation', () => {
  it('accepts a complete submission and normalises it', () => {
    const { valid, value } = validateContact(good);
    expect(valid).toBe(true);
    expect(value.email).toBe('dana@example.com');
    expect(value.name).toBe('Dana Reyes');
    expect(value.topic).toBe('billing');
    // The body keeps its line breaks; single-line fields are collapsed.
    expect(value.message).toBe('Line one.\nLine two.');
  });

  it('requires name, email, subject and message', () => {
    const { valid, fields } = validateContact({});
    expect(valid).toBe(false);
    expect(Object.keys(fields).sort()).toEqual(['email', 'message', 'name', 'subject']);
  });

  it('treats company as optional', () => {
    const { valid } = validateContact({ ...good, company: '' });
    expect(valid).toBe(true);
  });

  it('rejects a malformed address', () => {
    for (const email of ['nope', 'a@b', 'a b@c.com', 'a@b.c', '"x"@y.com', 'a@b.com, c@d.com']) {
      const { valid, fields } = validateContact({ ...good, email });
      expect(valid, email).toBe(false);
      expect(fields.email, email).toBeTruthy();
    }
  });

  it('enforces a maximum length on every field', () => {
    for (const [field, limit] of Object.entries(CONTACT_LIMITS)) {
      const overlong = field === 'email' ? `${'a'.repeat(limit)}@example.com` : 'a'.repeat(limit + 1);
      const { valid, fields } = validateContact({ ...good, [field]: overlong });
      expect(valid, field).toBe(false);
      expect(fields[field], field).toBeTruthy();
    }
  });

  it('falls back to a known topic when an unknown one is supplied', () => {
    expect(validateContact({ ...good, topic: 'anything' }).value.topic).toBe('other');
    expect(validateContact({ ...good, topic: '__proto__' }).value.topic).toBe('other');
  });

  it('ignores non-string field values instead of throwing', () => {
    const { valid, fields } = validateContact({ name: {}, email: 5, subject: [], message: null });
    expect(valid).toBe(false);
    expect(fields.name).toBeTruthy();
  });
});

describe('mail header safety', () => {
  it('refuses an address carrying a newline, so no header can be injected', () => {
    const { valid } = validateContact({
      ...good,
      email: 'a@b.com\nBcc: victim@example.com',
    });
    expect(valid).toBe(false);
  });

  it('strips control characters from single-line fields', () => {
    const { value } = validateContact({
      ...good,
      subject: 'Invoice\r\nBcc: victim@example.com',
    });
    expect(value.subject).not.toMatch(/[\r\n]/);
    expect(value.subject).toBe('Invoice Bcc: victim@example.com');
  });

  it('keeps carriage returns out of the message body', () => {
    const { value } = validateContact({ ...good, message: 'a\r\nb\r\nc' });
    expect(value.message).toBe('a\nb\nc');
    expect(value.message).not.toMatch(/\r/);
  });
});

describe('outgoing message construction', () => {
  const built = () => buildContactMessage({
    value: validateContact(good).value,
    recipient: 'info@dashflo.io',
    from: 'no-reply@dashflo.io',
    fromName: 'DashFlo Support',
  });

  it('always sends to the configured recipient', () => {
    expect(built().to).toBe('info@dashflo.io');
  });

  it('cannot be redirected by the submitted body', () => {
    // Every field a browser can set is hostile here. The recipient argument is
    // the only thing that decides delivery.
    const message = buildContactMessage({
      value: validateContact({
        ...good,
        name: 'attacker@evil.example',
        subject: 'x',
        message: 'To: attacker@evil.example',
      }).value,
      recipient: 'info@dashflo.io',
      from: 'no-reply@dashflo.io',
      fromName: 'DashFlo Support',
    });
    expect(message.to).toBe('info@dashflo.io');
  });

  it('sends from the authorised sender and replies to the visitor', () => {
    const message = built();
    expect(message.from).toBe('"DashFlo Support" <no-reply@dashflo.io>');
    expect(message.replyTo).toBe('dana@example.com');
    // The visitor's address must never become the envelope sender.
    expect(message.from).not.toContain('example.com');
  });

  it('keeps a preconfigured sender header untouched', () => {
    expect(senderIdentity('DashFlo <no-reply@dashflo.io>', 'Ignored')).toBe('DashFlo <no-reply@dashflo.io>');
  });

  /* The production Gmail identity.
   *
   * dashflo.io has catch-all INBOUND forwarding, which is why support@ and
   * info@ receive mail. It says nothing about who may send as them, and Gmail
   * is not authorised to, so From has to be the authenticated mailbox. Using
   * support@dashflo.io there would be a forgery that SPF and DMARC are built to
   * reject, and it would put delivery reputation behind a domain Gmail cannot
   * vouch for.
   *
   * The visitor still sees DashFlo Support, replies still reach the visitor,
   * and submissions still land at info@dashflo.io.
   */
  it('sends as the authenticated Gmail mailbox under the DashFlo Support name', () => {
    const message = buildContactMessage({
      value: validateContact(good).value,
      recipient: 'info@dashflo.io',
      from: 'team@legenex.com',
      fromName: 'DashFlo Support',
    });

    expect(message.from).toBe('"DashFlo Support" <team@legenex.com>');
    expect(message.to).toBe('info@dashflo.io');
    expect(message.replyTo).toBe('dana@example.com');

    // Not spoofed onto a dashflo.io mailbox that Gmail cannot send as.
    expect(message.from).not.toContain('support@dashflo.io');
    expect(message.from).not.toContain('info@dashflo.io');
  });

  it('labels the subject with the topic and bounds its length', () => {
    expect(built().subject).toBe('[Billing] Invoice question');
    const long = buildContactMessage({
      value: validateContact({ ...good, subject: 'a'.repeat(CONTACT_LIMITS.subject) }).value,
      recipient: 'info@dashflo.io',
      from: 'no-reply@dashflo.io',
      fromName: 'DashFlo Support',
    });
    expect(long.subject.length).toBeLessThanOrEqual(240);
  });

  it('carries the submitted detail in the body', () => {
    const text = built().text;
    expect(text).toContain('Dana Reyes');
    expect(text).toContain('dana@example.com');
    expect(text).toContain('Reyes Media');
    expect(text).toContain('Line one.');
  });
});

describe('honeypot', () => {
  it('detects a filled trap field', () => {
    expect(isHoneypotFilled({ website: 'https://spam.example' })).toBe(true);
    expect(isHoneypotFilled({ website: '   ' })).toBe(false);
    expect(isHoneypotFilled({})).toBe(false);
  });
});
