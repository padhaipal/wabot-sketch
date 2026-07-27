// Exercises every exported class in pp/outbound/outbound.dto.ts plus both
// branches of the TypeMatchesPayloadConstraint (the only embedded function
// with real logic). Pure validation — no module-level side effects.

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  PpAudioDto,
  PpMessageDto,
  PpMessageJobDto,
  PpSystemDto,
  PpTextDto,
  PpVideoDto,
} from './outbound.dto';

const okCarrier = { traceparent: 'tp' };

function build<T extends object>(cls: new () => T, src: object): T {
  return plainToInstance(cls, src);
}

describe('pp/outbound DTOs — leaf shapes', () => {
  it.each([
    [PpAudioDto, { url: 'https://x/y' }, 'url'],
    [PpVideoDto, { url: 'https://x/y' }, 'url'],
    [PpTextDto, { body: 'hi' }, 'body'],
    [PpSystemDto, { body: 'sys' }, 'body'],
  ])('%p validates a well-formed payload', (cls, src) => {
    expect(validateSync(build(cls as new () => object, src))).toHaveLength(0);
  });

  it.each([
    [PpAudioDto, { url: 42 }],
    [PpVideoDto, { url: null }],
    [PpTextDto, { body: 7 }],
    [PpSystemDto, { body: {} }],
  ])('%p rejects wrong-typed payload', (cls, src) => {
    expect(
      validateSync(build(cls as new () => object, src)).length,
    ).toBeGreaterThan(0);
  });
});

describe('PpMessageDto.TypeMatchesPayloadConstraint', () => {
  const base = {
    from: '911111111111',
    id: 'wamid.x',
    timestamp: '1700000000',
  };

  it('passes when type=text and only text is set', () => {
    const errs = validateSync(
      build(PpMessageDto, { ...base, type: 'text', text: { body: 'hi' } }),
    );
    expect(errs).toHaveLength(0);
  });

  it('fails when type=text but audio is set instead', () => {
    const errs = validateSync(
      build(PpMessageDto, {
        ...base,
        type: 'text',
        audio: { url: 'https://x' },
      }),
    );
    // The constraint reports under the private `typeMatchesPayload` field.
    const offender = errs.find((e) => e.property === 'typeMatchesPayload');
    expect(offender).toBeDefined();
    expect(Object.values(offender!.constraints ?? {})[0]).toMatch(
      /must match the populated field/,
    );
  });

  it('fails when two payloads are set simultaneously', () => {
    const errs = validateSync(
      build(PpMessageDto, {
        ...base,
        type: 'text',
        text: { body: 'hi' },
        video: { url: 'https://v' },
      }),
    );
    expect(errs.some((e) => e.property === 'typeMatchesPayload')).toBe(true);
  });

  it.each(['audio', 'video', 'system'] as const)(
    'passes when type=%s and only that payload is set',
    (type) => {
      const payload =
        type === 'audio' || type === 'video'
          ? { [type]: { url: 'https://x' } }
          : { [type]: { body: 'sys' } };
      const errs = validateSync(
        build(PpMessageDto, { ...base, type, ...payload }),
      );
      expect(errs).toHaveLength(0);
    },
  );
});

describe('PpMessageJobDto envelope', () => {
  const validMessage = {
    from: '911111111111',
    id: 'wamid.x',
    timestamp: '1700000000',
    type: 'text',
    text: { body: 'hi' },
  };

  it('accepts a fully valid envelope (consecutive omitted)', () => {
    expect(
      validateSync(
        build(PpMessageJobDto, {
          otel: { carrier: okCarrier },
          message: validMessage,
        }),
      ),
    ).toHaveLength(0);
  });

  it('accepts consecutive=true (IsBoolean + IsOptional branch)', () => {
    expect(
      validateSync(
        build(PpMessageJobDto, {
          otel: { carrier: okCarrier },
          message: validMessage,
          consecutive: true,
        }),
      ),
    ).toHaveLength(0);
  });

  it('rejects non-boolean consecutive', () => {
    const errs = validateSync(
      build(PpMessageJobDto, {
        otel: { carrier: okCarrier },
        message: validMessage,
        consecutive: 'yes' as unknown as boolean,
      }),
    );
    expect(errs.some((e) => e.property === 'consecutive')).toBe(true);
  });

  it('rejects when nested message fails its constraints', () => {
    const errs = validateSync(
      build(PpMessageJobDto, {
        otel: { carrier: okCarrier },
        message: { ...validMessage, type: 'audio' }, // payload mismatch
      }),
    );
    expect(errs.some((e) => e.property === 'message')).toBe(true);
  });
});

// ─── interactive / nfm_reply forwarding (2026-07) ────────────────────────────

import { PpInteractiveDto, PpNfmReplyDto } from './outbound.dto';

describe('PpMessageDto — interactive (flow tap) messages', () => {
  const interactiveMessage = {
    from: '+911234567890',
    id: 'wamid.tap',
    timestamp: '1750000000',
    type: 'interactive',
    interactive: {
      type: 'nfm_reply',
      nfm_reply: {
        name: 'flow',
        body: 'Sent',
        response_json: '{"answer_id":"opt-1"}',
      },
    },
  };

  it('accepts a well-formed nfm_reply message', () => {
    expect(validateSync(build(PpMessageDto, interactiveMessage))).toHaveLength(
      0,
    );
  });

  it('rejects type interactive without the interactive payload', () => {
    const errs = validateSync(
      build(PpMessageDto, { ...interactiveMessage, interactive: undefined }),
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects an nfm_reply missing response_json', () => {
    const errs = validateSync(
      build(PpNfmReplyDto, { name: 'flow', body: 'Sent' }),
    );
    expect(errs.some((e) => e.property === 'response_json')).toBe(true);
  });

  it('accepts other interactive subtypes without an nfm_reply payload', () => {
    // e.g. a button_reply we don't handle yet — forwarding stays permissive.
    expect(
      validateSync(build(PpInteractiveDto, { type: 'button_reply' })),
    ).toHaveLength(0);
  });
});
