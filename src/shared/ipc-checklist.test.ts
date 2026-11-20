import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ChecklistGetResult } from './ipc-checklist'

describe('checklist.get result', () => {
  it('get_result_has_flag_key', () => {
    const sample: ChecklistGetResult = { checklist: null, toolUnavailable: false }
    const handler = readFileSync(fileURLToPath(new URL('../../src-tauri/src/ipc/checklist.rs', import.meta.url)), 'utf8')
    const body = handler.slice(handler.indexOf('pub async fn get_with'), handler.indexOf('async fn refusal'))

    expect(Object.keys(sample).sort()).toEqual(['checklist', 'toolUnavailable'])
    for (const key of Object.keys(sample)) {
      expect(body).toContain(`"${key}"`)
    }
  })
})
