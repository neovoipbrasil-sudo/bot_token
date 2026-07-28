import { describe, it, expect } from 'vitest';
import { parseMsnTalkEvent } from './webhook-handler.js';

function ticketFixture(overrides = {}) {
  return {
    id: 92315,
    protocol: '2026200710580392315',
    contactId: 90604,
    contact: { id: 90604, number: '556121090177', name: 'Fulano' },
    ...overrides,
  };
}

describe('parseMsnTalkEvent', () => {
  it('normalizes an inbound customer message (method: message, fromMe: false)', () => {
    const event = parseMsnTalkEvent({
      method: 'message',
      msg: { fromMe: false, text: 'Bom dia', body: 'Bom dia', from: '556121090177', timestamp: 1784556288057 },
      ticket: ticketFixture(),
    });

    expect(event).toEqual({
      phone: '556121090177',
      text: 'Bom dia',
      direction: 'inbound',
      ticketId: 92315,
      protocol: '2026200710580392315',
      contactName: 'Fulano',
      timestamp: new Date(1784556288057).toISOString(),
    });
  });

  it('normalizes an outbound agent message sent from the panel (method: message, fromMe: true)', () => {
    const event = parseMsnTalkEvent({
      method: 'message',
      msg: { fromMe: true, text: 'Já te respondo', body: 'Já te respondo', timestamp: 1784556300000 },
      ticket: ticketFixture(),
    });

    expect(event.direction).toBe('outbound');
    expect(event.text).toBe('Já te respondo');
    expect(event.timestamp).toBe(new Date(1784556300000).toISOString());
  });

  it('falls back to msg.body when msg.text is missing', () => {
    const event = parseMsnTalkEvent({
      method: 'message',
      msg: { fromMe: false, body: 'só tem body' },
      ticket: ticketFixture(),
    });

    expect(event.text).toBe('só tem body');
  });

  it('falls back to the webhook receipt time when msg.timestamp is missing', () => {
    const before = Date.now();
    const event = parseMsnTalkEvent({
      method: 'message',
      msg: { fromMe: false, text: 'oi' },
      ticket: ticketFixture(),
    });
    const after = Date.now();

    const parsed = new Date(event.timestamp).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it('includes the WhatsApp contact name so multi-contact leads/deals can tell senders apart', () => {
    const event = parseMsnTalkEvent({
      method: 'message',
      msg: { fromMe: false, text: 'oi', timestamp: 1784556288057 },
      ticket: ticketFixture({ contact: { id: 90604, number: '556121090177', name: 'Maria Souza' } }),
    });

    expect(event.contactName).toBe('Maria Souza');
  });

  it('sets contactName to null when the ticket has no contact name', () => {
    const event = parseMsnTalkEvent({
      method: 'message',
      msg: { fromMe: false, text: 'oi', timestamp: 1784556288057 },
      ticket: ticketFixture({ contact: { id: 90604, number: '556121090177' } }),
    });

    expect(event.contactName).toBeNull();
  });

  it('normalizes an outbound reply sent via message_send_uazapi as always outbound', () => {
    const event = parseMsnTalkEvent({
      method: 'message_send_uazapi',
      msg: { message: '*Gabriel*: Queria confirmar...' },
      ticket: ticketFixture(),
    });

    expect(event.phone).toBe('556121090177');
    expect(event.text).toBe('*Gabriel*: Queria confirmar...');
    expect(event.direction).toBe('outbound');
    expect(event.ticketId).toBe(92315);
    expect(event.protocol).toBe('2026200710580392315');
    expect(event.contactName).toBe('Fulano');
    expect(typeof event.timestamp).toBe('string');
  });

  it('returns null for an unknown method', () => {
    const event = parseMsnTalkEvent({
      method: 'ticket_closed',
      ticket: ticketFixture(),
    });

    expect(event).toBeNull();
  });

  it('returns null when ticket.contact.number is missing', () => {
    const event = parseMsnTalkEvent({
      method: 'message',
      msg: { fromMe: false, text: 'oi' },
      ticket: { id: 1, protocol: 'x', contact: null },
    });

    expect(event).toBeNull();
  });

  it('returns null when the message text is empty', () => {
    const event = parseMsnTalkEvent({
      method: 'message',
      msg: { fromMe: false },
      ticket: ticketFixture(),
    });

    expect(event).toBeNull();
  });
});
