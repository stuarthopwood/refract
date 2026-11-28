import { describe, expect, it } from 'vitest'
import * as limits from './terminalLimits'

describe('terminalLimits', () => {
  it('exports_the_frozen_data_model_values', () => {
    expect({ ...limits }).toEqual({
      MAX_TABS_PER_SESSION: 8,
      SCROLLBACK_BYTES: 2097152,
      ASK_FALLBACK_LINES: 200,
      OUTPUT_CAP_BYTES: 32768,
      NAME_MAX_CHARS: 40,
      INPUT_MAX_BYTES: 65536,
      INPUT_RATE_BYTES_PER_SEC: 1048576,
      COLS_MAX: 500,
      ROWS_MAX: 200,
      ACK_EVERY_BYTES: 131072,
      UNACKED_PAUSE_BYTES: 524288
    })
  })

  it('acks_before_the_reader_would_pause', () => {
    expect(limits.ACK_EVERY_BYTES).toBeLessThan(limits.UNACKED_PAUSE_BYTES)
  })
})
