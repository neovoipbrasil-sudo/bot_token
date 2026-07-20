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
      msg: { fromMe: false, text: 'Bom dia', body: 'Bom dia', from: '556121090177' },
      ticket: ticketFixture(),
    });

    expect(event).toEqual({
      phone: '556121090177',
      text: 'Bom dia',
      direction: 'inbound',
      ticketId: 92315,
      protocol: '2026200710580392315',
    });
  });

  it('normalizes an outbound agent message sent from the panel (method: message, fromMe: true)', () => {
    const event = parseMsnTalkEvent({
      method: 'message',
      msg: { fromMe: true, text: 'Já te respondo', body: 'Já te respondo' },
      ticket: ticketFixture(),
    });

    expect(event.direction).toBe('outbound');
    expect(event.text).toBe('Já te respondo');
  });

  it('falls back to msg.body when msg.text is missing', () => {
    const event = parseMsnTalkEvent({
      method: 'message',
      msg: { fromMe: false, body: 'só tem body' },
      ticket: ticketFixture(),
    });

    expect(event.text).toBe('só tem body');
  });

  it('normalizes an outbound reply sent via message_send_uazapi as always outbound', () => {
    const event = parseMsnTalkEvent({
      method: 'message_send_uazapi',
      msg: { message: '*Gabriel*: Queria confirmar...' },
      ticket: ticketFixture(),
    });

    expect(event).toEqual({
      phone: '556121090177',
      text: '*Gabriel*: Queria confirmar...',
      direction: 'outbound',
      ticketId: 92315,
      protocol: '2026200710580392315',
    });
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
