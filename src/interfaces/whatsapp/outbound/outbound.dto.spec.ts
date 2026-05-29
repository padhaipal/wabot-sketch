// Covers every exported class in whatsapp/outbound/outbound.dto.ts with a
// valid + invalid case each. Pure validation; no module side effects.

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  SendMessageDeliveredDto,
  SendMessageNotDeliveredDto,
  TypingIndicatorDto,
  UploadMediaResultDto,
  WaMediaObjectDto,
  WaReadAndTypingRequestDto,
  WaReadAndTypingResponseDto,
  WaSendMessageContactDto,
  WaSendMessageMessageDto,
  WaSendMessageRequestDto,
  WaSendMessageResponseDto,
  WaTextBodyDto,
  WaUploadMediaResponseDto,
} from './outbound.dto';

function build<T extends object>(cls: new () => T, src: object): T {
  return plainToInstance(cls, src);
}

describe('whatsapp/outbound leaf DTOs', () => {
  it.each([
    [TypingIndicatorDto, { type: 'text' }],
    [WaReadAndTypingResponseDto, { success: true }],
    [WaTextBodyDto, { body: 'hi' }],
    [WaMediaObjectDto, { link: 'https://x', id: 'mid' }],
    [WaMediaObjectDto, {}], // both fields optional
    [WaSendMessageContactDto, { input: '+1', wa_id: '911' }],
    [WaSendMessageMessageDto, { id: 'wamid' }],
    [WaSendMessageMessageDto, { id: 'wamid', message_status: 'accepted' }],
    [SendMessageDeliveredDto, { delivered: true }],
    [SendMessageNotDeliveredDto, { delivered: false, reason: 'inflight-expired' }],
    [SendMessageNotDeliveredDto, { delivered: false, reason: 'whatsapp-error' }],
    [WaUploadMediaResponseDto, { id: 'media-1' }],
    [UploadMediaResultDto, { wa_media_url: 'https://x' }],
  ])('%p validates a good payload', (cls, src) => {
    expect(validateSync(build(cls as new () => object, src))).toHaveLength(0);
  });

  it.each([
    [TypingIndicatorDto, { type: 'audio' }], // not in ['text']
    [WaReadAndTypingResponseDto, { success: 'yes' }],
    [WaTextBodyDto, { body: 42 }],
    [WaMediaObjectDto, { link: 7 }],
    [WaSendMessageContactDto, { wa_id: '911' }],
    [WaSendMessageMessageDto, { id: 5 }],
    [WaSendMessageMessageDto, { id: 'wamid', message_status: 'bad' }],
    [SendMessageDeliveredDto, { delivered: 'yes' }],
    [SendMessageNotDeliveredDto, { delivered: false }], // reason missing
    [WaUploadMediaResponseDto, {}],
    [UploadMediaResultDto, { wa_media_url: null }],
  ])('%p rejects a bad payload', (cls, src) => {
    expect(
      validateSync(build(cls as new () => object, src)).length,
    ).toBeGreaterThan(0);
  });
});

describe('WaReadAndTypingRequestDto', () => {
  it('accepts a well-formed request', () => {
    expect(
      validateSync(
        build(WaReadAndTypingRequestDto, {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: 'wamid',
          typing_indicator: { type: 'text' },
        }),
      ),
    ).toHaveLength(0);
  });

  it('rejects when nested typing_indicator is malformed', () => {
    const errs = validateSync(
      build(WaReadAndTypingRequestDto, {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: 'wamid',
        typing_indicator: { type: 'audio' },
      }),
    );
    expect(errs.some((e) => e.property === 'typing_indicator')).toBe(true);
  });

  it('rejects when message_id is missing', () => {
    const errs = validateSync(
      build(WaReadAndTypingRequestDto, {
        messaging_product: 'whatsapp',
        status: 'read',
        typing_indicator: { type: 'text' },
      }),
    );
    expect(errs.some((e) => e.property === 'message_id')).toBe(true);
  });
});

describe('WaSendMessageRequestDto', () => {
  const base = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '911111111111',
  };

  it.each(['text', 'audio', 'video', 'image'] as const)(
    'accepts type=%s with the matching nested payload',
    (type) => {
      const payload =
        type === 'text' ? { text: { body: 'hi' } } : { [type]: { link: 'https://x' } };
      expect(
        validateSync(build(WaSendMessageRequestDto, { ...base, type, ...payload })),
      ).toHaveLength(0);
    },
  );

  it('rejects an unknown type', () => {
    const errs = validateSync(
      build(WaSendMessageRequestDto, { ...base, type: 'sticker' }),
    );
    expect(errs.some((e) => e.property === 'type')).toBe(true);
  });

  it('rejects when nested text payload is wrong-typed', () => {
    const errs = validateSync(
      build(WaSendMessageRequestDto, {
        ...base,
        type: 'text',
        text: { body: 42 },
      }),
    );
    expect(errs.some((e) => e.property === 'text')).toBe(true);
  });
});

describe('WaSendMessageResponseDto', () => {
  it('accepts a fully valid response', () => {
    expect(
      validateSync(
        build(WaSendMessageResponseDto, {
          messaging_product: 'whatsapp',
          contacts: [{ input: '+1', wa_id: '911' }],
          messages: [{ id: 'wamid' }],
        }),
      ),
    ).toHaveLength(0);
  });

  it('rejects when contacts is not an array', () => {
    const errs = validateSync(
      build(WaSendMessageResponseDto, {
        messaging_product: 'whatsapp',
        contacts: { input: '+1', wa_id: '911' } as unknown as never,
        messages: [{ id: 'wamid' }],
      }),
    );
    expect(errs.some((e) => e.property === 'contacts')).toBe(true);
  });

  it('rejects when a nested message lacks id', () => {
    const errs = validateSync(
      build(WaSendMessageResponseDto, {
        messaging_product: 'whatsapp',
        contacts: [{ input: '+1', wa_id: '911' }],
        messages: [{ message_status: 'accepted' }],
      }),
    );
    expect(errs.some((e) => e.property === 'messages')).toBe(true);
  });
});
